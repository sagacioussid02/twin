variable "project_name" {
  description = "Name prefix for all resources"
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.project_name))
    error_message = "Project name must contain only lowercase letters, numbers, and hyphens."
  }
}

variable "environment" {
  description = "Environment name (dev, test, prod)"
  type        = string
  validation {
    condition     = contains(["dev", "test", "prod"], var.environment)
    error_message = "Environment must be one of: dev, test, prod."
  }
}

variable "bedrock_model_id" {
  description = "Bedrock model ID"
  type        = string
  default     = "us.amazon.nova-2-lite-v1:0"
}

variable "lambda_timeout" {
  description = "Lambda function timeout in seconds"
  type        = number
  default     = 60
}

variable "api_throttle_burst_limit" {
  description = "API Gateway throttle burst limit"
  type        = number
  default     = 10
}

variable "api_throttle_rate_limit" {
  description = "API Gateway throttle rate limit"
  type        = number
  default     = 5
}

variable "use_custom_domain" {
  description = "Attach a custom domain to CloudFront"
  type        = bool
  default     = false
}

variable "root_domain" {
  description = "Apex domain name, e.g. mydomain.com"
  type        = string
  default     = ""
}

variable "session_hmac_secret" {
  description = "Server secret for deriving opaque chat session keys (HMAC-SHA256). Generate with: python -c \"import secrets; print(secrets.token_hex(32))\""
  type        = string
  sensitive   = true
  validation {
    condition     = length(trimspace(var.session_hmac_secret)) >= 64 && can(regex("^[0-9a-f]+$", trimspace(var.session_hmac_secret)))
    error_message = "session_hmac_secret must be a hex-encoded secret of at least 32 bytes (64 hex characters). Generate one with: python -c \"import secrets; print(secrets.token_hex(32))\""
  }
}

variable "clerk_jwks_url" {
  description = "Clerk JWKS URL for JWT verification, e.g. https://<your-clerk-domain>/.well-known/jwks.json"
  type        = string
  validation {
    condition     = length(trimspace(var.clerk_jwks_url)) > 0
    error_message = "clerk_jwks_url must be set to the Clerk JWKS URL; the backend requires CLERK_JWKS_URL for authenticated routes."
  }
}

variable "ses_from_email" {
  description = "SES-verified sender email for connect-to-creator notifications (leave empty to disable)"
  type        = string
  default     = ""
}

variable "admin_emails" {
  description = "Comma-separated admin emails to notify on connect requests, e.g. you@example.com"
  type        = string
  default     = ""
}

variable "ses_region" {
  description = "AWS region where the SES sender identity is verified (must match the region used by the Lambda SES client)"
  type        = string
  default     = "us-east-1"
}