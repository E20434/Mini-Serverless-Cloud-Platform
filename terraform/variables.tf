variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "project_name" {
  type    = string
  default = "mini-cloud"
}

variable "db_password" {
  description = "Postgres master password - pass via TF_VAR_db_password, never commit it"
  type        = string
  sensitive   = true
}

variable "jwt_secret" {
  description = "JWT signing secret - pass via TF_VAR_jwt_secret, never commit it"
  type        = string
  sensitive   = true
}

variable "worker_instance_type" {
  description = "The ONE EC2 instance backing the Worker's ECS capacity - needs a real Docker daemon (Fargate can't provide one), so it can't be Fargate. Smallest practical size to keep cost near-zero for a short verification window."
  type        = string
  default     = "t3.micro"
}
