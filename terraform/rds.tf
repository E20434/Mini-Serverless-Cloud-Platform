# Replaces the docker-compose Postgres. db.t4g.micro is the smallest
# practical class (~$0.016/hr) - single-AZ, no read replica, no backups
# retained (backup_retention_period = 0), deletion_protection off,
# skip_final_snapshot true - every one of these would be the WRONG
# choice for production (no HA, no backups, no safety net on delete) and
# the RIGHT choice for a short-lived, intentionally-torn-down learning
# deployment. Not publicly accessible - reached only from inside the VPC
# by the api/worker security groups (see security_groups.tf); a one-off
# ECS task runs migrations instead of this needing to be reachable from
# a laptop.
resource "aws_db_subnet_group" "main" {
  name       = "${var.project_name}-db-subnets"
  subnet_ids = aws_subnet.public[*].id
}

resource "aws_db_instance" "postgres" {
  identifier              = "${var.project_name}-db"
  engine                  = "postgres"
  engine_version          = "16"
  instance_class          = "db.t4g.micro"
  allocated_storage       = 20
  storage_type            = "gp3"
  db_name                 = "mini_cloud"
  username                = "mini_cloud"
  password                = var.db_password
  db_subnet_group_name    = aws_db_subnet_group.main.name
  vpc_security_group_ids  = [aws_security_group.data.id]
  publicly_accessible     = false
  skip_final_snapshot     = true
  deletion_protection     = false
  backup_retention_period = 0
  multi_az                = false
  tags = { Name = "${var.project_name}-db" }
}
