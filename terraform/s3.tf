# Replaces MinIO. Same @aws-sdk/client-s3 code (Phase 5) talks to this
# with zero code changes to the S3 calls themselves - only credentials
# resolution changes (see ObjectStorageService's AWS-vs-MinIO branch).
resource "aws_s3_bucket" "function_source" {
  bucket_prefix = "${var.project_name}-fn-source-"
  # force_destroy lets `terraform destroy` delete this bucket even with
  # objects still in it - correct for a learning deployment we intend to
  # tear down promptly; would be a dangerous default in production.
  force_destroy = true
  tags = { Name = "${var.project_name}-function-source" }
}
