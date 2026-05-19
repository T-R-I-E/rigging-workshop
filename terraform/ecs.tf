resource "aws_ecs_cluster" "this" {
  name = var.project_name
}

resource "aws_cloudwatch_log_group" "tasks" {
  name              = "/ecs/${var.project_name}"
  retention_in_days = var.log_retention_days
}

locals {
  image_uri = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
}

resource "aws_ecs_task_definition" "this" {
  family                   = var.project_name
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "main"
      image     = local.image_uri
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
      image     = local.image_uri
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

  # New revision when the image tag changes.
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
    subnets          = local.public_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.main.arn
    container_name   = "main"
    container_port   = 7878
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.bb.arn
    container_name   = "bb"
    container_port   = 7879
  }

  depends_on = [
    aws_lb_listener.http,
    null_resource.docker_build_push,
  ]

  lifecycle {
    ignore_changes = [desired_count]
  }
}
