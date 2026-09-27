# Least-privilege IAM, five distinct roles for five distinct jobs - the
# real-AWS version of the API-key SCOPES from Phase 9: nothing gets more
# permission than the one thing it actually needs to do.
data "aws_caller_identity" "current" {}

# --- ECS task EXECUTION role: what ECS itself uses to START a container
# (pull the image, inject SSM params as env vars, write to CloudWatch) -
# NOT what the application code inside the container can do. Shared by
# both the API and Worker task definitions; identical needs either way.
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_task_execution" {
  name               = "${var.project_name}-ecs-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_managed" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "ecs_task_execution_ssm" {
  statement {
    actions   = ["ssm:GetParameters"]
    resources = ["arn:aws:ssm:${var.aws_region}:*:parameter/${var.project_name}/*"]
  }
  statement {
    # SecureString params are KMS-encrypted with the default AWS-managed
    # SSM key - decrypting them at task-start time needs this, not the
    # cost/setup of a customer-managed key.
    actions   = ["kms:Decrypt"]
    resources = ["*"]
  }
  statement {
    # AmazonECSTaskExecutionRolePolicy (attached above) covers
    # CreateLogStream/PutLogEvents but NOT CreateLogGroup - found live
    # when the migrate task failed to start with
    # "not authorized to perform: logs:CreateLogGroup", since every task
    # definition here relies on "awslogs-create-group": "true".
    actions = ["logs:CreateLogGroup"]
    resources = [
      "arn:aws:logs:${var.aws_region}:*:log-group:/${var.project_name}/*",
    ]
  }
}

resource "aws_iam_role_policy" "ecs_task_execution_ssm" {
  name   = "${var.project_name}-ecs-exec-ssm"
  role   = aws_iam_role.ecs_task_execution.id
  policy = data.aws_iam_policy_document.ecs_task_execution_ssm.json
}

# --- API TASK role: what the API's own application CODE can do at
# runtime (distinct from the execution role above) - S3 for function
# source, and starting/polling the CodeBuild project that replaces local
# `docker build` (see src/build/codebuild-executor.ts).
data "aws_iam_policy_document" "api_task_permissions" {
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.function_source.arn, "${aws_s3_bucket.function_source.arn}/*"]
  }
  statement {
    actions   = ["codebuild:StartBuild", "codebuild:BatchGetBuilds"]
    resources = [aws_codebuild_project.build.arn]
  }
}

resource "aws_iam_role" "api_task" {
  name               = "${var.project_name}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "api_task_permissions" {
  name   = "${var.project_name}-api-task-permissions"
  role   = aws_iam_role.api_task.id
  policy = data.aws_iam_policy_document.api_task_permissions.json
}

# --- WORKER task role: a real, non-obvious wrinkle - ECS's own
# image-pull auth only covers the ONE image named in a task definition
# when that task starts. It does nothing for the arbitrary per-function
# images the Worker's OWN code later asks the shared host daemon to
# `docker run`, once per invocation (see src/worker/ecr-login.ts). This
# role exists so the Worker can authenticate those pulls itself, using
# its own identity - not because ECS didn't already handle "its own"
# image.
data "aws_iam_policy_document" "worker_task_permissions" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # this specific action has no resource-level permissions in IAM - it's account-wide by definition
  }
  statement {
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
    resources = [aws_ecr_repository.functions.arn]
  }
}

resource "aws_iam_role" "worker_task" {
  name               = "${var.project_name}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "worker_task_permissions" {
  name   = "${var.project_name}-worker-task-permissions"
  role   = aws_iam_role.worker_task.id
  policy = data.aws_iam_policy_document.worker_task_permissions.json
}

# --- CodeBuild service role: what a build JOB itself can do - pull the
# handler source from S3, build+push to ECR (privileged mode, since
# `docker build` inside CodeBuild needs it), write its own logs.
data "aws_iam_policy_document" "codebuild_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "codebuild" {
  name               = "${var.project_name}-codebuild"
  assume_role_policy = data.aws_iam_policy_document.codebuild_assume.json
}

data "aws_iam_policy_document" "codebuild_permissions" {
  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["*"]
  }
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.function_source.arn}/*"]
  }
  statement {
    actions = [
      "ecr:GetAuthorizationToken",
    ]
    resources = ["*"]
  }
  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage",
      "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage",
    ]
    resources = [aws_ecr_repository.runtime.arn, aws_ecr_repository.functions.arn]
  }
}

resource "aws_iam_role_policy" "codebuild_permissions" {
  name   = "${var.project_name}-codebuild-permissions"
  role   = aws_iam_role.codebuild.id
  policy = data.aws_iam_policy_document.codebuild_permissions.json
}

# --- EC2 instance role: required for ANY EC2 host to register itself as
# ECS container-instance capacity at all - this is what lets the ECS
# agent running on the Worker's one EC2 instance talk to the ECS control
# plane (RegisterContainerInstance, poll for tasks, report status). The
# AWS-managed policy is the standard, correct choice here - not a
# shortcut.
data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_instance" {
  name               = "${var.project_name}-ecs-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "ecs_instance_managed" {
  role       = aws_iam_role.ecs_instance.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

resource "aws_iam_instance_profile" "ecs_instance" {
  name = "${var.project_name}-ecs-instance-profile"
  role = aws_iam_role.ecs_instance.name
}
