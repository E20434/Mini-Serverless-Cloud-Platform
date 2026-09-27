# The real replacement for local `docker build` on AWS - the exact
# transition Part 2's original AWS-mapping table predicted at the very
# start of this project ("Build Service -> CodeBuild"). Deliberately
# generic: NO_SOURCE + an inline buildspec that reads its actual work
# (which function, which source object, which image tag) from environment
# variables the API passes at StartBuild time (see
# src/build/codebuild-executor.ts) - one Project serves every build,
# rather than provisioning infrastructure per function.
resource "aws_codebuild_project" "build" {
  name          = "${var.project_name}-build"
  service_role  = aws_iam_role.codebuild.arn
  build_timeout = 10 # minutes - these are single-file functions; anything longer means something is wrong

  source {
    type      = "NO_SOURCE"
    buildspec = file("${path.module}/../codebuild/buildspec.yml")
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL" # cheapest tier - billed per build-minute, not continuously
    image                       = "aws/codebuild/standard:7.0" # ships Docker CLI + AWS CLI preinstalled
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
    privileged_mode             = true # required for `docker build` to run at all inside a CodeBuild container
  }

  artifacts {
    type = "NO_ARTIFACTS" # the real output is an image pushed to ECR, not a CodeBuild artifact bundle
  }

  logs_config {
    cloudwatch_logs {
      group_name = "/${var.project_name}/codebuild"
    }
  }
}
