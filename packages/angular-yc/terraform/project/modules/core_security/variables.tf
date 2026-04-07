variable "app_name" {
  description = "Application name"
  type        = string
}

variable "env" {
  description = "Environment"
  type        = string
}

variable "create_database_secret" {
  description = "Create database connection secret"
  type        = bool
  default     = false
}

variable "database_username" {
  description = "Database username"
  type        = string
  default     = "app_user"
}

variable "database_endpoint" {
  description = "Database endpoint"
  type        = string
  default     = ""
}

variable "tags" {
  description = "Resource tags"
  type        = map(string)
  default     = {}
}