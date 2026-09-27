# SSM Parameter Store, not Secrets Manager, and it's a real cost decision
# worth naming: Secrets Manager charges a flat $0.40/secret/MONTH,
# non-prorated - creating 5 secrets for a 20-minute verification window
# would still bill the full month for each one. SSM Parameter Store's
# Standard tier (used here, SecureString with the default AWS-managed
# KMS key) is free. Secrets Manager's real advantage - automatic
# rotation - isn't a factor for a short-lived learning deployment;
# stated here as the real reason a production system would often still
# choose it anyway.
resource "aws_ssm_parameter" "database_url" {
  name  = "/${var.project_name}/DATABASE_URL"
  type  = "SecureString"
  value = "postgresql://${aws_db_instance.postgres.username}:${var.db_password}@${aws_db_instance.postgres.endpoint}/${aws_db_instance.postgres.db_name}?schema=public"
}

resource "aws_ssm_parameter" "redis_url" {
  name  = "/${var.project_name}/REDIS_URL"
  type  = "String" # no credentials in this value - matches our existing REDIS_URL, which never had any either
  value = "redis://${aws_elasticache_cluster.redis.cache_nodes[0].address}:6379"
}

resource "aws_ssm_parameter" "jwt_secret" {
  name  = "/${var.project_name}/JWT_SECRET"
  type  = "SecureString"
  value = var.jwt_secret
}

resource "aws_ssm_parameter" "s3_bucket" {
  name  = "/${var.project_name}/S3_BUCKET"
  type  = "String"
  value = aws_s3_bucket.function_source.bucket
}

resource "aws_ssm_parameter" "s3_region" {
  name  = "/${var.project_name}/S3_REGION"
  type  = "String"
  value = var.aws_region
}
