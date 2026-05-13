variable "region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Name prefix applied to AWS resources."
  type        = string
  default     = "rigging-workshop"
}

variable "image_tag" {
  description = "Tag to push to ECR and pull from the task definition. Bump to force a rebuild + redeploy."
  type        = string
  default     = "latest"
}

variable "task_cpu" {
  description = "Fargate task CPU units. Both JVMs share this. 1024 = 1 vCPU."
  type        = string
  default     = "1024"
}

variable "task_memory" {
  description = "Fargate task memory in MiB. Both JVMs share this."
  type        = string
  default     = "2048"
}

variable "log_retention_days" {
  description = "CloudWatch log retention for the task containers."
  type        = number
  default     = 7
}
