variable "talos_version" {
  default = "1.9.1"
}

variable "kubernetes_version" {
  default = "1.31.4"
}

variable "cluster_name" {
  default = "tanzen-dev"
}

variable "cluster_vip" {
  default = "10.17.5.9"
}

variable "cluster_endpoint" {
  default = "https://10.17.5.9:6443"
}

variable "cluster_network" {
  default = "10.17.5.0/24"
}

variable "cluster_gateway" {
  default = "10.17.5.1"
}

variable "controller_count" {
  default = 1
}

variable "worker_count" {
  default = 2
}

variable "controller_cpu" {
  default = 4
}

variable "controller_memory_gb" {
  default = 8
}

variable "controller_disk_gb" {
  default = 40
}

variable "worker_cpu" {
  default = 4
}

variable "worker_memory_gb" {
  default = 16
}

variable "worker_disk_gb" {
  default = 60
}

variable "base_volume_name" {
  default = "talos-kata-spin.qcow2"
}

variable "prefix" {
  default = "tz"
}

variable "lb_first_hostnum" {
  default = 130
}

variable "lb_last_hostnum" {
  default = 230
}
