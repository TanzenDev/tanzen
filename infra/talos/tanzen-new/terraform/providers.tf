terraform {
  required_version = "~> 1.10"
  required_providers {
    libvirt = { source = "dmacvicar/libvirt", version = "0.8.1" }
    talos   = { source = "siderolabs/talos",  version = "0.7.0" }
    helm    = { source = "hashicorp/helm",    version = "2.17.0" }
  }
}
provider "libvirt" { uri = "qemu:///system" }
provider "talos"   {}
provider "helm"    {}
