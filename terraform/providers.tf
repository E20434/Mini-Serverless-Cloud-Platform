terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  # No remote backend (S3 + DynamoDB lock table) - a real team would use
  # one so state is shared and locked. For a single-operator learning
  # deployment, local state is an explicit, reasonable simplification -
  # terraform.tfstate lives in this directory and is gitignored.
}

# profile = "mini-faas" is not a default - it's the whole point. This
# account is dedicated to this project specifically so it can never touch
# a real employer's AWS environment, which also happens to have its own
# profile configured on this machine.
provider "aws" {
  region  = var.aws_region
  profile = "mini-faas"
}
