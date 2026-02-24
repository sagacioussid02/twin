output "api_gateway_url" {
  description = "Base URL of the API Gateway"
  value       = "${aws_apigatewayv2_api.main.api_endpoint}"
}

output "s3_frontend_bucket" {
  description = "Name of the S3 bucket for frontend hosting"
  value       = aws_s3_bucket.frontend.id
}

output "cloudfront_url" {
  description = "CloudFront distribution domain name"
  value       = aws_cloudfront_distribution.main.domain_name
}

output "custom_domain_url" {
  description = "Custom domain URL if configured"
  value       = var.use_custom_domain && var.root_domain != "" ? var.root_domain : ""
}
