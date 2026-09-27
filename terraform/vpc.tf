# Deliberate, cost-driven simplification: PUBLIC subnets only, no NAT
# Gateway. A NAT Gateway costs ~$0.045/hr PLUS data processing charges,
# continuously, whether or not anything is using it - a real recurring
# bill for a short-lived learning deployment. RDS/ElastiCache still stay
# genuinely unreachable from the internet, enforced at the SECURITY GROUP
# layer (see security_groups.tf), not by subnet routing - "public subnet"
# only means "has a route to an Internet Gateway," not "open to the
# world." A real production system would still prefer private subnets +
# NAT/VPC endpoints as defense in depth; this is a named, explained
# tradeoff, not an oversight.
data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags = { Name = "${var.project_name}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags = { Name = "${var.project_name}-igw" }
}

# 2 subnets across 2 AZs - the minimum RDS's subnet group requires, even
# running single-AZ.
resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.20.${count.index}.0/24"
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
  tags = { Name = "${var.project_name}-public-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${var.project_name}-public-rt" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}
