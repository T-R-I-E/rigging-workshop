terraform {
  required_version = ">= 1.5.0"

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
}

provider "aws" {
  region = var.region
}

data "aws_vpc" "default" {
  default = true
}

# The default VPC in this account has had some default subnets converted
# to private (associated with a route table that lacks an IGW route).
# Selecting subnets purely by `default-for-az` lets Fargate place a task
# in a private subnet and the ECR image pull then times out. Filter by
# actual IGW reachability instead.
#
# Note: aws_route_table with subnet_id falls back to the main route
# table when the subnet has no explicit association, so this catches
# subnets that inherit a public main RT too.
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
  # Route tables with at least one 0.0.0.0/0 → IGW route.
  igw_rt_ids = [
    for rt in data.aws_route_table.all_each : rt.route_table_id
    if length([
      for r in rt.routes : r
      if r.gateway_id != null && startswith(r.gateway_id, "igw-")
    ]) > 0
  ]

  # Does the VPC's main route table have an IGW route? If so, subnets
  # without an explicit RT association inherit a public RT.
  main_rt_is_public = anytrue([
    for rt in data.aws_route_table.all_each :
    contains(local.igw_rt_ids, rt.route_table_id) && anytrue([
      for a in rt.associations : a.main
    ])
  ])

  # Subnets explicitly attached to a non-IGW route table (definitely private).
  explicit_private_subnet_ids = distinct(flatten([
    for rt in data.aws_route_table.all_each : [
      for a in rt.associations : a.subnet_id
      if !contains(local.igw_rt_ids, rt.route_table_id) && a.subnet_id != null && a.subnet_id != ""
    ]
  ]))

  # Subnets explicitly attached to an IGW route table.
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

data "aws_caller_identity" "current" {}
