resource "libvirt_network" "talos" {
  name      = "${var.prefix}-talos"
  mode      = "nat"
  addresses = [var.cluster_network]
  dhcp { enabled = true }
  dns  { enabled = true }
}

resource "libvirt_volume" "controller" {
  count            = var.controller_count
  name             = "${var.prefix}-controller-${count.index}.qcow2"
  pool             = "default"
  format           = "qcow2"
  base_volume_name = var.base_volume_name
  base_volume_pool = "default"
  size             = var.controller_disk_gb * 1024 * 1024 * 1024
}

resource "libvirt_volume" "worker" {
  count            = var.worker_count
  name             = "${var.prefix}-worker-${count.index}.qcow2"
  pool             = "default"
  format           = "qcow2"
  base_volume_name = var.base_volume_name
  base_volume_pool = "default"
  size             = var.worker_disk_gb * 1024 * 1024 * 1024
}

resource "libvirt_domain" "controller" {
  count  = var.controller_count
  name   = "${var.prefix}-controller-${count.index}"
  vcpu   = var.controller_cpu
  memory = var.controller_memory_gb * 1024
  machine = "q35"
  cpu { mode = "host-passthrough" }

  disk { volume_id = libvirt_volume.controller[count.index].id }

  network_interface {
    network_id     = libvirt_network.talos.id
    wait_for_lease = true
  }

  console {
    type        = "pty"
    target_port = "0"
    target_type = "serial"
  }
}

resource "libvirt_domain" "worker" {
  count  = var.worker_count
  name   = "${var.prefix}-worker-${count.index}"
  vcpu   = var.worker_cpu
  memory = var.worker_memory_gb * 1024
  machine = "q35"
  cpu { mode = "host-passthrough" }

  disk { volume_id = libvirt_volume.worker[count.index].id }

  network_interface {
    network_id     = libvirt_network.talos.id
    wait_for_lease = true
  }

  console {
    type        = "pty"
    target_port = "0"
    target_type = "serial"
  }
}
