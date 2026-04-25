variable "talos_version" {
  description = "Talos version — must match the base image"
  default     = "v1.12.6"
}

variable "kubernetes_version" {
  description = "Kubernetes version bundled with the Talos version"
  default     = "v1.35.2"
}

variable "cluster_name" {
  default = "tanzen"
}

variable "cluster_vip" {
  description = "Keepalived VIP for the control plane — must be in cluster_network but outside DHCP range"
  default     = "10.17.5.9"
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

variable "controller_ip" {
  description = "Static IP for the controller node (must be in cluster_network)"
  default     = "10.17.5.80"
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
  description = "Talos base image in libvirt default pool (must include kata-containers extension)"
  default     = "talos-v1.12.6-kata.qcow2"
}

variable "prefix" {
  default = "tz"
}
