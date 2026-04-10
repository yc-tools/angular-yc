# Read cloud_id and folder_id from provider configuration
data "yandex_client_config" "current" {}

# Load deployment manifest
locals {
  manifest = jsondecode(file(var.manifest_path))

  build_id = local.manifest.buildId

  # Resource naming
  prefix = "${var.app_name}-${var.env}"

  # TLS certificate mode
  external_certificate_id  = trimspace(var.certificate_id)
  use_external_certificate = local.external_certificate_id != ""
  certificate_id           = local.use_external_certificate ? local.external_certificate_id : yandex_cm_certificate.main[0].id

  # Bucket mode
  external_assets_bucket     = trimspace(var.assets_bucket_name)
  use_external_assets_bucket = local.external_assets_bucket != ""

  # Common labels (for other resources - requires map of strings)
  common_labels = {
    app        = var.app_name
    env        = var.env
    build_id   = local.build_id
    managed_by = "terraform"
  }
}

# ============================================================================
# Security Module
# ============================================================================

module "security" {
  source = "./modules/core_security"

  app_name = var.app_name
  env      = var.env
  tags     = local.common_labels
}

# ============================================================================
# Storage Resources
# ============================================================================

# Assets bucket for static files
resource "yandex_storage_bucket" "assets" {
  count = local.use_external_assets_bucket ? 0 : 1

  bucket        = "${local.prefix}-assets-${random_id.bucket_suffix.hex}"
  force_destroy = true

  # Encryption - Yandex Object Storage encrypts all data at rest by default
  # No need to specify encryption configuration as it's always enabled

  # Versioning for rollback capability
  versioning {
    enabled = true
  }

  # CORS for Angular assets
  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = var.allowed_origins
    max_age_seconds = 3600
  }

  # Lifecycle rules for old versions
  lifecycle_rule {
    enabled = true
    id      = "cleanup-old-versions"

    noncurrent_version_expiration {
      days = 30
    }
  }

  # Auto-expire cached images
  lifecycle_rule {
    enabled = true
    id      = "expire-cache-prefix"
    prefix  = "_cache/"

    expiration {
      days = var.cache_ttl_days
    }
  }

  # Access control - bucket is private by default
  acl = "private"

  # Yandex Object Storage enforces HTTPS by default
  # No need for additional policy to force HTTPS

  tags = local.common_labels
}

locals {
  assets_bucket = local.use_external_assets_bucket ? local.external_assets_bucket : yandex_storage_bucket.assets[0].bucket
}

# ============================================================================
# YDB Serverless Database for Response cache Metadata
# ============================================================================

# Create YDB Serverless database for Response cache metadata
resource "yandex_ydb_database_serverless" "response_cache" {
  count = var.enable_response_cache ? 1 : 0

  name        = "${local.prefix}-response-cache-db"
  description = "Serverless YDB database for Response cache metadata"

  serverless_database {
    enable_throttling_rcu_limit = false
    provisioned_rcu_limit       = 10
    storage_size_limit          = 10 # GB
    throttling_rcu_limit        = 0
  }

  labels = local.common_labels
}

# Service account for YDB access
resource "yandex_iam_service_account" "ydb" {
  count = var.enable_response_cache ? 1 : 0

  name        = "${local.prefix}-ydb-sa"
  description = "Service account for YDB access"
}

# Grant YDB editor role
resource "yandex_resourcemanager_folder_iam_member" "ydb_editor" {
  count = var.enable_response_cache ? 1 : 0

  folder_id = data.yandex_client_config.current.folder_id
  role      = "ydb.editor"
  member    = "serviceAccount:${yandex_iam_service_account.ydb[0].id}"
}

# Create static access key for YDB
resource "yandex_iam_service_account_static_access_key" "ydb" {
  count = var.enable_response_cache ? 1 : 0

  service_account_id = yandex_iam_service_account.ydb[0].id
  description        = "Static key for YDB access"
}

# ============================================================================
# Cloud Functions
# ============================================================================

# Service account for functions
resource "yandex_iam_service_account" "functions" {
  name        = "${local.prefix}-functions-sa"
  description = "Service account for Cloud Functions"
}

# Grant necessary permissions
resource "yandex_resourcemanager_folder_iam_member" "functions_invoker" {
  folder_id = data.yandex_client_config.current.folder_id
  role      = "serverless.functions.invoker"
  member    = "serviceAccount:${yandex_iam_service_account.functions.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "storage_viewer" {
  folder_id = data.yandex_client_config.current.folder_id
  role      = "storage.viewer"
  member    = "serviceAccount:${yandex_iam_service_account.functions.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "storage_editor" {
  folder_id = data.yandex_client_config.current.folder_id
  role      = "storage.editor"
  member    = "serviceAccount:${yandex_iam_service_account.functions.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "lockbox_payload_viewer" {
  folder_id = data.yandex_client_config.current.folder_id
  role      = "lockbox.payloadViewer"
  member    = "serviceAccount:${yandex_iam_service_account.functions.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "ydb_editor_functions" {
  folder_id = data.yandex_client_config.current.folder_id
  role      = "ydb.editor"
  member    = "serviceAccount:${yandex_iam_service_account.functions.id}"
}

# Server function (SSR/API)
resource "yandex_function" "server" {
  count = local.manifest.capabilities.rendering.needsServer ? 1 : 0

  name               = "${local.prefix}-server-function"
  description        = "Angular SSR and API handler"
  user_hash          = local.build_id
  runtime            = "nodejs${var.nodejs_version}"
  entrypoint         = local.manifest.artifacts.server.entry
  memory             = local.manifest.deployment.functions.server.memory
  execution_timeout  = local.manifest.deployment.functions.server.timeout
  service_account_id = yandex_iam_service_account.functions.id
  depends_on = [
    yandex_resourcemanager_folder_iam_member.functions_invoker,
    yandex_resourcemanager_folder_iam_member.storage_viewer,
    yandex_resourcemanager_folder_iam_member.storage_editor,
    yandex_resourcemanager_folder_iam_member.lockbox_payload_viewer,
    yandex_resourcemanager_folder_iam_member.ydb_editor_functions,
  ]

  # Environment variables
  environment = merge(
    local.manifest.artifacts.server.env,
    {
      BUILD_ID              = local.build_id
      NODE_ENV              = "production"
      ASSETS_BUCKET         = local.assets_bucket
      NG_ALLOWED_HOSTS      = var.domain_name
      AYC_DEBUG             = var.env != "production" ? "1" : "0"
      AYC_CACHE_YDB_ENDPOINT      = var.enable_response_cache ? yandex_ydb_database_serverless.response_cache[0].ydb_api_endpoint : ""
      AYC_CACHE_YDB_DATABASE      = var.enable_response_cache ? yandex_ydb_database_serverless.response_cache[0].database_path : ""
      AYC_CACHE_YDB_ACCESS_KEY_ID = var.enable_response_cache ? yandex_iam_service_account_static_access_key.ydb[0].access_key : ""
      AYC_CACHE_YDB_SECRET_KEY    = var.enable_response_cache ? yandex_iam_service_account_static_access_key.ydb[0].secret_key : ""
      REVALIDATE_SECRET_ID  = module.security.revalidate_secret_id
      CACHE_PURGE_SECRET_ID = module.security.revalidate_secret_id
    }
  )

  # Secrets from Lockbox
  secrets {
    id                   = module.security.revalidate_secret_id
    version_id           = module.security.revalidate_secret_version
    key                  = "hmac_secret"
    environment_variable = "REVALIDATE_SECRET"
  }

  secrets {
    id                   = module.security.revalidate_secret_id
    version_id           = module.security.revalidate_secret_version
    key                  = "hmac_secret"
    environment_variable = "CACHE_PURGE_SECRET"
  }

  # Function package
  package {
    bucket_name = local.assets_bucket
    object_name = "functions/server.zip"
  }

}

# Image optimization function
resource "yandex_function" "image" {
  count = local.manifest.capabilities.assets.needsImage ? 1 : 0

  name               = "${local.prefix}-image-function"
  description        = "Angular image optimization handler"
  user_hash          = local.build_id
  runtime            = "nodejs${var.nodejs_version}"
  entrypoint         = local.manifest.artifacts.image.entry
  memory             = local.manifest.deployment.functions.image.memory
  execution_timeout  = local.manifest.deployment.functions.image.timeout
  service_account_id = yandex_iam_service_account.functions.id
  depends_on = [
    yandex_resourcemanager_folder_iam_member.functions_invoker,
    yandex_resourcemanager_folder_iam_member.storage_viewer,
    yandex_resourcemanager_folder_iam_member.storage_editor,
    yandex_resourcemanager_folder_iam_member.lockbox_payload_viewer,
  ]

  environment = merge(
    local.manifest.artifacts.image.env,
    {
      BUILD_ID      = local.build_id
      NODE_ENV      = "production"
      ASSETS_BUCKET = local.assets_bucket
    }
  )

  package {
    bucket_name = local.assets_bucket
    object_name = "functions/image.zip"
  }

}

# ============================================================================
# API Gateway
# ============================================================================

# Generate OpenAPI spec from template
locals {
  openapi_spec = templatefile("${path.module}/templates/openapi.yaml.tpl", {
    api_name           = "${local.prefix}-api"
    assets_bucket      = local.assets_bucket
    server_function_id = local.manifest.capabilities.rendering.needsServer ? yandex_function.server[0].id : ""
    image_function_id  = local.manifest.capabilities.assets.needsImage ? yandex_function.image[0].id : ""
    service_account_id = yandex_iam_service_account.functions.id
    has_server         = local.manifest.capabilities.rendering.needsServer
    has_image          = local.manifest.capabilities.assets.needsImage
  })
}

resource "yandex_api_gateway" "main" {
  name        = "${local.prefix}-api-gateway"
  description = "API Gateway for Angular application"

  depends_on = [
    yandex_function.server,
    yandex_function.image,
    yandex_dns_recordset.validation,
  ]

  spec = local.openapi_spec

  custom_domains {
    fqdn           = var.domain_name
    certificate_id = local.certificate_id
  }

  labels = local.common_labels
}

# ============================================================================
# CDN (Optional)
# ============================================================================

resource "yandex_cdn_origin_group" "main" {
  count = var.enable_cdn ? 1 : 0

  name = "${local.prefix}-cdn-origins"

  origin {
    source  = yandex_api_gateway.main.domain
    enabled = true
    backup  = false
  }
}

resource "yandex_cdn_resource" "main" {
  count = var.enable_cdn ? 1 : 0

  cname               = var.domain_name
  origin_group_id     = yandex_cdn_origin_group.main[0].id
  origin_protocol     = "https"
  active              = true

  ssl_certificate {
    type                   = "cm"
    certificate_manager_id = local.certificate_id
  }

  options {
    edge_cache_settings    = var.cdn_edge_cache_ttl
    browser_cache_settings = 0
    ignore_query_params    = false
    cors                   = var.allowed_origins
    gzip_on                = true
  }
}

# ============================================================================
# DNS and TLS Certificate
# ============================================================================

resource "yandex_dns_zone" "main" {
  count = var.create_dns_zone ? 1 : 0

  name        = "${local.prefix}-zone"
  description = "DNS zone for ${var.domain_name}"
  zone        = "${var.domain_name}."
  public      = true

  labels = local.common_labels
}

resource "yandex_cm_certificate" "main" {
  count = local.use_external_certificate ? 0 : 1

  name    = "${local.prefix}-cert"
  domains = [var.domain_name]

  managed {
    challenge_type = "DNS_CNAME"
  }

  labels = local.common_labels
}

# DNS validation records
resource "yandex_dns_recordset" "validation" {
  for_each = local.use_external_certificate ? {} : { "0" = true }

  zone_id = var.create_dns_zone ? yandex_dns_zone.main[0].id : var.dns_zone_id
  name    = yandex_cm_certificate.main[0].challenges[0].dns_name
  type    = "CNAME"
  ttl     = 60
  data    = [yandex_cm_certificate.main[0].challenges[0].dns_value]
}

# API Gateway custom domain
resource "yandex_dns_recordset" "api_gateway" {
  count = (var.create_dns_zone || trimspace(var.dns_zone_id) != "") ? 1 : 0

  zone_id = var.create_dns_zone ? yandex_dns_zone.main[0].id : var.dns_zone_id
  name    = "${trimsuffix(var.domain_name, ".")}."
  type    = "CNAME"
  ttl     = 300
  data    = [var.enable_cdn ? yandex_cdn_resource.main[0].cname : yandex_api_gateway.main.domain]
}

# ============================================================================
# Monitoring and Logging
# ============================================================================

# Create log group for functions
resource "yandex_logging_group" "functions" {
  name             = "${local.prefix}-functions-logs"
  description      = "Logs for Cloud Functions"
  folder_id        = data.yandex_client_config.current.folder_id
  retention_period = "168h" # 7 days

  labels = local.common_labels
}

# ============================================================================
# Helper Resources
# ============================================================================

resource "random_id" "bucket_suffix" {
  byte_length = 4
}
