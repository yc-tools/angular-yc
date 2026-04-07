output "api_gateway_domain" {
  description = "API Gateway domain"
  value       = yandex_api_gateway.main.domain
}

output "api_gateway_id" {
  description = "API Gateway ID"
  value       = yandex_api_gateway.main.id
}

output "custom_domain" {
  description = "Custom domain name"
  value       = var.domain_name
}

output "certificate_status" {
  description = "TLS certificate status"
  value       = local.use_external_certificate ? null : yandex_cm_certificate.main[0].status
}

output "certificate_id" {
  description = "TLS certificate ID (external or managed)"
  value       = local.use_external_certificate ? local.external_certificate_id : yandex_cm_certificate.main[0].id
}

output "assets_bucket" {
  description = "Assets bucket name"
  value       = local.assets_bucket
}

output "cdn_domain" {
  description = "CDN domain"
  value       = var.enable_cdn ? yandex_cdn_resource.main[0].cname : null
}

output "server_function_id" {
  description = "Server function ID"
  value       = local.manifest.capabilities.rendering.needsServer ? yandex_function.server[0].id : null
}

output "server_function_version" {
  description = "Server function version ID"
  value       = local.manifest.capabilities.rendering.needsServer ? yandex_function.server[0].version : null
}

output "image_function_id" {
  description = "Image function ID"
  value       = local.manifest.capabilities.assets.needsImage ? yandex_function.image[0].id : null
}

output "image_function_version" {
  description = "Image function version ID"
  value       = local.manifest.capabilities.assets.needsImage ? yandex_function.image[0].version : null
}

output "ydb_endpoint" {
  description = "YDB endpoint"
  value       = var.enable_response_cache ? yandex_ydb_database_serverless.response_cache[0].ydb_full_endpoint : null
  sensitive   = true
}

output "ydb_database" {
  description = "YDB database path"
  value       = var.enable_response_cache ? yandex_ydb_database_serverless.response_cache[0].database_path : null
}

output "lockbox_secret_ids" {
  description = "Lockbox secret IDs (not values)"
  value = {
    cache_purge_secret = module.security.revalidate_secret_id
  }
}

output "service_account_id" {
  description = "Service account ID for functions"
  value       = yandex_iam_service_account.functions.id
}

output "log_group_id" {
  description = "Log group ID for functions"
  value       = yandex_logging_group.functions.id
}

output "deployment_info" {
  description = "Deployment information"
  value = {
    build_id    = local.build_id
    deployed_at = timestamp()
    region      = var.region
    environment = var.env
  }
}

output "dns_zone_id" {
  description = "DNS zone ID"
  value       = var.create_dns_zone ? yandex_dns_zone.main[0].id : null
}
