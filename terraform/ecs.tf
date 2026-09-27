resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-cluster"
  setting {
    name  = "containerInsights"
    value = "disabled" # Container Insights bills separately per metric - skip it for a short learning deployment
  }
}

# --- EC2 capacity for the Worker ONLY - the one thing that genuinely
# needs a real Docker daemon (docker run per invocation), which Fargate
# cannot provide at all. One instance, fixed size (min=max=desired=1) -
# this is explicitly NOT the Worker's real horizontal-scaling story
# (that's Phase 8/11's job, proven on Kubernetes in Phase 12); it's the
# minimum needed to prove the invoke path runs on real AWS compute.
data "aws_ssm_parameter" "ecs_ami" {
  name = "/aws/service/ecs/optimized-ami/amazon-linux-2/recommended/image_id"
}

resource "aws_launch_template" "worker" {
  name_prefix   = "${var.project_name}-worker-"
  image_id      = data.aws_ssm_parameter.ecs_ami.value
  instance_type = var.worker_instance_type

  iam_instance_profile {
    arn = aws_iam_instance_profile.ecs_instance.arn
  }

  vpc_security_group_ids = [aws_security_group.worker.id]

  # Tells the ECS agent baked into the AMI which cluster to join - the
  # ENTIRE reason this instance shows up as usable capacity at all.
  user_data = base64encode(<<-EOF
    #!/bin/bash
    echo ECS_CLUSTER=${aws_ecs_cluster.main.name} >> /etc/ecs/ecs.config
  EOF
  )

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${var.project_name}-worker-instance" }
  }
}

resource "aws_autoscaling_group" "worker" {
  name                = "${var.project_name}-worker-asg"
  min_size            = 1
  max_size            = 1
  desired_capacity    = 1
  vpc_zone_identifier = aws_subnet.public[*].id

  launch_template {
    id      = aws_launch_template.worker.id
    version = "$Latest"
  }

  tag {
    key                 = "AmazonECSManaged"
    value               = true
    propagate_at_launch = true
  }
}

resource "aws_ecs_capacity_provider" "worker" {
  name = "${var.project_name}-worker-cp"
  auto_scaling_group_provider {
    auto_scaling_group_arn = aws_autoscaling_group.worker.arn
    managed_scaling {
      status          = "ENABLED"
      target_capacity = 100
    }
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = [aws_ecs_capacity_provider.worker.name, "FARGATE"]
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# --- Worker task: EC2 launch type, bridge networking, two host-path
# volumes - the EXACT same DooD pattern proven in Phase 12's kind
# cluster (docker.sock for a real daemon; a shared scratch directory,
# because Phase 12 already found that a container-private /tmp isn't
# visible to the host daemon for bind-mount purposes). Zero code changes
# needed here - containerExecutor.ts's HOST_SCRATCH_DIR variable was
# built for exactly this in Phase 12.
resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.project_name}-worker"
  requires_compatibilities = ["EC2"]
  network_mode             = "bridge"
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.worker_task.arn
  cpu                      = 256
  memory                   = 400

  volume {
    name      = "docker-sock"
    host_path = "/var/run/docker.sock"
  }
  volume {
    name      = "scratch"
    host_path = "/tmp/mini-cloud-scratch"
  }

  container_definitions = jsonencode([{
    name      = "worker"
    image     = "${aws_ecr_repository.worker.repository_url}:latest"
    essential = true
    environment = [
      { name = "HOST_SCRATCH_DIR", value = "/tmp/mini-cloud-scratch" },
      { name = "WORKER_METRICS_PORT", value = "9200" },
      # See src/worker/ecr-login.ts - unset (both are) anywhere else, and
      # the Worker's per-invocation `docker run` calls just skip ECR auth
      # entirely, exactly as they do today locally and on Kubernetes.
      { name = "ECR_REGISTRY", value = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com" },
      { name = "AWS_REGION", value = var.aws_region },
    ]
    secrets = [
      { name = "REDIS_URL", valueFrom = aws_ssm_parameter.redis_url.arn },
    ]
    mountPoints = [
      { sourceVolume = "docker-sock", containerPath = "/var/run/docker.sock" },
      { sourceVolume = "scratch", containerPath = "/tmp/mini-cloud-scratch" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = "/${var.project_name}/worker"
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "worker"
        "awslogs-create-group"  = "true"
      }
    }
  }])
}

resource "aws_ecs_service" "worker" {
  name            = "${var.project_name}-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = 1

  capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.worker.name
    weight            = 1
  }

  depends_on = [aws_ecs_cluster_capacity_providers.main]
}

# --- API task: Fargate, awsvpc networking, a public IP directly (no ALB
# - see terraform/README.md for the cost tradeoff). No docker.sock at
# all - the whole point of moving the Build pipeline to CodeBuild is that
# THIS container never needs Docker access on AWS, even though the
# IDENTICAL image also supports local `docker build` via BUILD_EXECUTOR
# (see src/build/build-executor.ts).
resource "aws_ecs_task_definition" "api" {
  family                   = "${var.project_name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.api_task.arn

  container_definitions = jsonencode([{
    name         = "api"
    image        = "${aws_ecr_repository.api.repository_url}:latest"
    essential    = true
    portMappings = [{ containerPort = 3000, protocol = "tcp" }]
    environment = [
      { name = "PORT", value = "3000" },
      { name = "S3_BUCKET", value = aws_s3_bucket.function_source.bucket },
      { name = "S3_REGION", value = var.aws_region },
      { name = "WORKER_METRICS_PORT", value = "9200" },
      { name = "BUILD_EXECUTOR", value = "codebuild" },
      { name = "CODEBUILD_PROJECT_NAME", value = aws_codebuild_project.build.name },
      { name = "RUNTIME_IMAGE_URI", value = "${aws_ecr_repository.runtime.repository_url}:latest" },
      { name = "FUNCTIONS_ECR_REPO_URI", value = aws_ecr_repository.functions.repository_url },
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = aws_ssm_parameter.database_url.arn },
      { name = "REDIS_URL", valueFrom = aws_ssm_parameter.redis_url.arn },
      { name = "JWT_SECRET", valueFrom = aws_ssm_parameter.jwt_secret.arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = "/${var.project_name}/api"
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "api"
        "awslogs-create-group"  = "true"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name            = "${var.project_name}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = true
  }
}

# --- A ONE-OFF task definition, not a service - the ECS equivalent of a
# Kubernetes Job. Run manually once via `aws ecs run-task` after Postgres
# exists, to apply migrations. Never runs continuously, so it costs
# essentially nothing.
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.project_name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.api_task.arn

  container_definitions = jsonencode([{
    name      = "migrate"
    image     = "${aws_ecr_repository.api.repository_url}:latest"
    essential = true
    command   = ["npx", "prisma", "migrate", "deploy"]
    secrets = [
      { name = "DATABASE_URL", valueFrom = aws_ssm_parameter.database_url.arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = "/${var.project_name}/migrate"
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "migrate"
        "awslogs-create-group"  = "true"
      }
    }
  }])
}
