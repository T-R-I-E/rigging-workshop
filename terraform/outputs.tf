output "alb_dns_name" {
  description = "Public DNS for the load balancer. /rigcheck-bb* -> bb (7879), everything else -> main (7878)."
  value       = aws_lb.this.dns_name
}

output "alb_url" {
  description = "Convenience HTTP URL."
  value       = "http://${aws_lb.this.dns_name}"
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
