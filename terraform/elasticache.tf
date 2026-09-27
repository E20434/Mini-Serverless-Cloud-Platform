# Replaces the docker-compose Redis. cache.t4g.micro, single node, no
# replication group - the same cost-vs-durability tradeoff as rds.tf,
# same reasoning: this is Redis Streams state (Phase 6/7/8), not the
# durable source of truth (that's Postgres) - losing it would be a real
# outage but not data loss the way losing Postgres would be.
resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.project_name}-cache-subnets"
  subnet_ids = aws_subnet.public[*].id
}

resource "aws_elasticache_cluster" "redis" {
  cluster_id         = "${var.project_name}-redis"
  engine             = "redis"
  engine_version     = "7.1"
  node_type          = "cache.t4g.micro"
  num_cache_nodes    = 1
  port               = 6379
  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.data.id]
}
