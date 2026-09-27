# Four repositories: the two platform components (api/worker), the base
# runtime image (Phase 2's mini-cloud-runtime, now what CodeBuild's
# generated Dockerfiles FROM), and ONE repo for every per-function image
# - matching Phase 5's existing tagging scheme (mini-cloud-fn-<name>:<version>).
# ECR repos are closer to namespaces than individual image slots; many
# tags, one repo, is the normal pattern here, not one repo per function.
resource "aws_ecr_repository" "api" {
  name         = "${var.project_name}-api"
  force_delete = true
}

resource "aws_ecr_repository" "worker" {
  name         = "${var.project_name}-worker"
  force_delete = true
}

resource "aws_ecr_repository" "runtime" {
  name         = "${var.project_name}-runtime"
  force_delete = true
}

resource "aws_ecr_repository" "functions" {
  name         = "${var.project_name}-fn"
  force_delete = true
}
