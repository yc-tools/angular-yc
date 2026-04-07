output "kms_key_id" {
  description = "KMS key ID for encryption"
  value       = yandex_kms_symmetric_key.main.id
}

output "revalidate_secret_id" {
  description = "Lockbox secret ID for cache purge HMAC"
  value       = yandex_lockbox_secret.revalidate.id
}

output "revalidate_secret_version" {
  description = "Lockbox secret version ID for cache purge HMAC"
  value       = yandex_lockbox_secret_version.revalidate.id
}

output "database_secret_id" {
  description = "Lockbox secret ID for database credentials"
  value       = var.create_database_secret ? yandex_lockbox_secret.database[0].id : null
}

output "api_gateway_sa_id" {
  description = "API Gateway service account ID"
  value       = yandex_iam_service_account.api_gateway.id
}

output "monitoring_sa_id" {
  description = "Monitoring service account ID"
  value       = yandex_iam_service_account.monitoring.id
}
