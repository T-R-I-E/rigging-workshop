variable "hosted_zone" {
  description = "Trailing-dot Route53 hosted zone name (e.g. todaq.net.)."
  type        = string
  nullable    = false
}

variable "domain_name" {
  description = "FQDN to point at the ALB (e.g. rigchecker.todaq.net)."
  type        = string
  nullable    = false
}

variable "lb_dns_name" {
  type     = string
  nullable = false
}

variable "lb_zone_id" {
  type     = string
  nullable = false
}

data "aws_route53_zone" "this" {
  name         = var.hosted_zone
  private_zone = false
}

resource "aws_route53_record" "app" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = var.lb_dns_name
    zone_id                = var.lb_zone_id
    evaluate_target_health = true
  }
}

output "zone_id" {
  value = data.aws_route53_zone.this.zone_id
}

output "public_fqdn" {
  value = aws_route53_record.app.fqdn
}
