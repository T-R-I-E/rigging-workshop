output "cloudfront_url" {
  description = "Public HTTPS URL. Hit this from browsers. /rigcheck-bb* -> bb, /rigcheck-clj* -> main, everything else -> main."
  value       = "https://${aws_cloudfront_distribution.this.domain_name}"
}

output "alb_dns_name" {
  description = "Internal-only: ALB DNS. Direct hits are blocked by SG (CloudFront-only)."
  value       = aws_lb.this.dns_name
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "ecs_cluster" {
  value = aws_ecs_cluster.this.name
}

output "ecs_service" {
  value = aws_ecs_service.this.name
}

output "log_group" {
  value = aws_cloudwatch_log_group.tasks.name
}
