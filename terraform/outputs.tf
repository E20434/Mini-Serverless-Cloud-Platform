output "ecr_api_repo" {
  value = aws_ecr_repository.api.repository_url
}
output "ecr_worker_repo" {
  value = aws_ecr_repository.worker.repository_url
}
output "ecr_runtime_repo" {
  value = aws_ecr_repository.runtime.repository_url
}
output "ecr_functions_repo" {
  value = aws_ecr_repository.functions.repository_url
}
output "s3_bucket" {
  value = aws_s3_bucket.function_source.bucket
}
output "rds_endpoint" {
  value = aws_db_instance.postgres.endpoint
}
output "redis_endpoint" {
  value = aws_elasticache_cluster.redis.cache_nodes[0].address
}
output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}
output "codebuild_project_name" {
  value = aws_codebuild_project.build.name
}
output "migrate_task_definition_arn" {
  value = aws_ecs_task_definition.migrate.arn
}
output "api_subnets" {
  value = aws_subnet.public[*].id
}
output "api_security_group" {
  value = aws_security_group.api.id
}
