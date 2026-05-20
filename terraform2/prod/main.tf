terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }

  backend "s3" {
    bucket       = "rigchecker-terraform-state"
    key          = "prod/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = local.aws_region
}

locals {
  project_name = "rigchecker"
  domain_name  = "rigchecker.todaq.net"
  hosted_zone  = "todaq.net."
  aws_region   = "us-east-1"

  image_tag   = "latest"
  task_cpu    = "1024"
  task_memory = "2048"
}

# Default VPC + public-subnet selection filtered by actual IGW reachability.
# The account's default VPC has had some subnets converted to private
# (no IGW route on their RT). Selecting by default-for-az would land a
# Fargate task in one of those and the ECR image pull would time out.
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "all" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

data "aws_route_tables" "all" {
  vpc_id = data.aws_vpc.default.id
}

data "aws_route_table" "all_each" {
  for_each       = toset(data.aws_route_tables.all.ids)
  route_table_id = each.value
}

locals {
  igw_rt_ids = [
    for rt in data.aws_route_table.all_each : rt.route_table_id
    if length([
      for r in rt.routes : r
      if r.gateway_id != null && startswith(r.gateway_id, "igw-")
    ]) > 0
  ]

  main_rt_is_public = anytrue([
    for rt in data.aws_route_table.all_each :
    contains(local.igw_rt_ids, rt.route_table_id) && anytrue([
      for a in rt.associations : a.main
    ])
  ])

  explicit_private_subnet_ids = distinct(flatten([
    for rt in data.aws_route_table.all_each : [
      for a in rt.associations : a.subnet_id
      if !contains(local.igw_rt_ids, rt.route_table_id) && a.subnet_id != null && a.subnet_id != ""
    ]
  ]))

  explicit_public_subnet_ids = distinct(flatten([
    for rt in data.aws_route_table.all_each : [
      for a in rt.associations : a.subnet_id
      if contains(local.igw_rt_ids, rt.route_table_id) && a.subnet_id != null && a.subnet_id != ""
    ]
  ]))

  public_subnet_ids = local.main_rt_is_public ? [
    for s in data.aws_subnets.all.ids : s
    if !contains(local.explicit_private_subnet_ids, s)
  ] : local.explicit_public_subnet_ids
}

module "ecr" {
  source       = "../modules/ecr"
  project_name = local.project_name
}

module "dns" {
  source      = "../modules/dns"
  hosted_zone = local.hosted_zone
  domain_name = local.domain_name
  lb_dns_name = module.alb.lb_dns_name
  lb_zone_id  = module.alb.lb_zone_id
}

module "alb" {
  source       = "../modules/alb"
  project_name = local.project_name
  vpc_id       = data.aws_vpc.default.id
  subnet_ids   = local.public_subnet_ids
  domain_name  = local.domain_name
  zone_id      = module.dns.zone_id
}

module "ecs" {
  source                = "../modules/ecs"
  project_name          = local.project_name
  region                = local.aws_region
  vpc_id                = data.aws_vpc.default.id
  subnet_ids            = local.public_subnet_ids
  alb_security_group_id = module.alb.alb_security_group_id
  image_uri             = "${module.ecr.repository_url}:${local.image_tag}"
  task_cpu              = local.task_cpu
  task_memory           = local.task_memory
  log_retention_days    = 7
  main_target_group_arn = module.alb.main_target_group_arn
  bb_target_group_arn   = module.alb.bb_target_group_arn

  depends_on = [null_resource.docker_build_push]
}

output "public_url" {
  value = "https://${module.dns.public_fqdn}"
}

output "alb_dns_name" {
  value = module.alb.lb_dns_name
}

output "ecr_repository_url" {
  value = module.ecr.repository_url
}

output "ecs_cluster" {
  value = module.ecs.cluster_name
}

output "ecs_service" {
  value = module.ecs.service_name
}

output "log_group" {
  value = module.ecs.log_group_name
}
