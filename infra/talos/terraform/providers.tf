terraform {
  required_version = ">= 1.5"
  required_providers {
    libvirt = { source = "dmacvicar/libvirt", version = "0.8.1" }
    talos   = { source = "siderolabs/talos",  version = "0.10.1" }
  }
}

# Runs on tanzen0 directly — no SSH tunnel needed.
provider "libvirt" { uri = "qemu:///system" }
provider "talos"   {}
