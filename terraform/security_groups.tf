# Real Security Groups, real least-privilege - the actual barrier
# keeping "public subnet" from meaning "open to the internet." Postgres
# and Redis accept connections ONLY from the api/worker security groups
# by REFERENCE (not by CIDR) - a security group rule that names another
# security group, not an IP range, so it stays correct even as ECS tasks
# get IPs assigned and released dynamically.
resource "aws_security_group" "api" {
  name_prefix = "${var.project_name}-api-"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "API HTTP - direct task IP for this learning deployment (no ALB - see terraform/README.md)"
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project_name}-api-sg" }
}

resource "aws_security_group" "worker" {
  name_prefix = "${var.project_name}-worker-"
  vpc_id      = aws_vpc.main.id

  # No ingress at all - nothing calls the Worker over HTTP (Phase 7's
  # design, unchanged: work arrives via Redis Streams). Outbound only:
  # ECR pulls, Redis, RDS is not even needed here (Worker touches zero
  # Postgres, Phase 7's design, still true on AWS).
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project_name}-worker-sg" }
}

resource "aws_security_group" "data" {
  name_prefix = "${var.project_name}-data-"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Postgres from API and Worker only"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.api.id, aws_security_group.worker.id]
  }

  ingress {
    description     = "Redis from API and Worker only"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.api.id, aws_security_group.worker.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project_name}-data-sg" }
}
