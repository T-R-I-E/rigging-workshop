variable "project_name" {
  type     = string
  nullable = false
}

variable "region" {
  type     = string
  nullable = false
}

variable "vpc_id" {
  type     = string
  nullable = false
}

variable "subnet_ids" {
  type     = list(string)
  nullable = false
}

variable "alb_security_group_id" {
  type     = string
  nullable = false
}

variable "image_uri" {
  description = "Full <ecr-url>:<tag> the task pulls."
  type        = string
  nullable    = false
}

variable "task_cpu" {
  type    = string
  default = "1024"
}

variable "task_memory" {
  type    = string
  default = "2048"
}

variable "log_retention_days" {
  type    = number
  default = 7
}

variable "main_target_group_arn" {
  type     = string
  nullable = false
}

variable "bb_target_group_arn" {
  type     = string
  nullable = false
}

resource "aws_security_group" "tasks" {
  name        = "${var.project_name}-tasks"
  description = "Fargate task ingress only from the ALB."
  vpc_id      = var.vpc_id

  ingress {
    description     = "main JVM"
    from_port       = 7878
    to_port         = 7878
    protocol        = "tcp"
    security_groups = [var.alb_security_group_id]
  }

  ingress {
    description     = "bb JVM"
    from_port       = 7879
    to_port         = 7879
    protocol        = "tcp"
    security_groups = [var.alb_security_group_id]
  }

  egress {
    description = "All egress (image pulls, etc.)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${var.project_name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution_managed" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Task role: permissions the running containers themselves need. Required
# whenever enable_execute_command is true so the SSM agent inside the
# container can open its channels back to AWS.
resource "aws_iam_role" "task" {
  name               = "${var.project_name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "task_exec_ssm" {
  statement {
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "task_exec_ssm" {
  name   = "${var.project_name}-exec-ssm"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_exec_ssm.json
}

resource "aws_ecs_cluster" "this" {
  name = var.project_name
}

resource "aws_cloudwatch_log_group" "tasks" {
  name              = "/ecs/${var.project_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "this" {
  family                   = var.project_name
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = "main"
      image     = var.image_uri
      essential = true
      command   = ["-M:server"]
      portMappings = [{
        containerPort = 7878
        hostPort      = 7878
        protocol      = "tcp"
      }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.tasks.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "main"
        }
      }
    },
    {
      name      = "bb"
      image     = var.image_uri
      essential = true
      command   = ["-M:server-bb"]
      portMappings = [{
        containerPort = 7879
        hostPort      = 7879
        protocol      = "tcp"
      }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.tasks.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "bb"
        }
      }
    }
  ])

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_ecs_service" "this" {
  name                   = var.project_name
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.this.arn
  desired_count          = 1
  launch_type            = "FARGATE"
  force_new_deployment   = true
  enable_execute_command = true

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = var.main_target_group_arn
    container_name   = "main"
    container_port   = 7878
  }

  load_balancer {
    target_group_arn = var.bb_target_group_arn
    container_name   = "bb"
    container_port   = 7879
  }

  lifecycle {
    ignore_changes = [desired_count]
  }
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "service_name" {
  value = aws_ecs_service.this.name
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.tasks.name
}
