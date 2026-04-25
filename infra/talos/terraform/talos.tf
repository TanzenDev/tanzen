resource "talos_machine_secrets" "talos" {}

locals {
  controller_ip = var.controller_ip
  worker_ips    = [for i in range(var.worker_count) : cidrhost(var.cluster_network, 90 + i)]
}

data "talos_machine_configuration" "controller" {
  cluster_name       = var.cluster_name
  cluster_endpoint   = var.cluster_endpoint
  machine_type       = "controlplane"
  machine_secrets    = talos_machine_secrets.talos.machine_secrets
  talos_version      = var.talos_version
  kubernetes_version = var.kubernetes_version

  config_patches = [
    yamlencode({
      machine = {
        install = {
          disk = "/dev/vda"
        }
        network = {
          interfaces = [{
            interface = "eth0"
            addresses = ["${local.controller_ip}/24"]
            routes    = [{ network = "0.0.0.0/0", gateway = var.cluster_gateway }]
            vip       = { ip = var.cluster_vip }
          }]
        }
        kubelet = {
          extraArgs = { "rotate-server-certificates" = "true" }
        }
        features = {
          kubePrism = { enabled = true, port = 7445 }
          hostDNS   = { enabled = true, forwardKubeDNSToHost = true }
        }
      }
      cluster = {
        network = { cni = { name = "none" } }
        proxy   = { disabled = true }
        apiServer = {
          certSANs = [var.cluster_vip, local.controller_ip]
        }
        inlineManifests = [
          {
            name     = "runtimeclass-kata"
            contents = yamlencode({
              apiVersion = "node.k8s.io/v1"
              kind       = "RuntimeClass"
              metadata   = { name = "kata" }
              handler    = "kata"
            })
          }
        ]
      }
    })
  ]
}

data "talos_machine_configuration" "worker" {
  cluster_name       = var.cluster_name
  cluster_endpoint   = var.cluster_endpoint
  machine_type       = "worker"
  machine_secrets    = talos_machine_secrets.talos.machine_secrets
  talos_version      = var.talos_version
  kubernetes_version = var.kubernetes_version

  config_patches = [
    yamlencode({
      machine = {
        install = {
          disk = "/dev/vda"
        }
        nodeLabels = {
          "kata.tanzen.dev/capable" = "true"
        }
        kubelet = {
          extraArgs = { "rotate-server-certificates" = "true" }
        }
        features = {
          kubePrism = { enabled = true, port = 7445 }
          hostDNS   = { enabled = true, forwardKubeDNSToHost = true }
        }
      }
    })
  ]
}

resource "talos_machine_configuration_apply" "controller" {
  count                       = var.controller_count
  client_configuration        = talos_machine_secrets.talos.client_configuration
  machine_configuration_input = data.talos_machine_configuration.controller.machine_configuration
  node                        = tolist(libvirt_domain.controller[count.index].network_interface)[0].addresses[0]
  endpoint                    = tolist(libvirt_domain.controller[count.index].network_interface)[0].addresses[0]

  depends_on = [libvirt_domain.controller]
}

resource "talos_machine_configuration_apply" "worker" {
  count                       = var.worker_count
  client_configuration        = talos_machine_secrets.talos.client_configuration
  machine_configuration_input = data.talos_machine_configuration.worker.machine_configuration
  node                        = tolist(libvirt_domain.worker[count.index].network_interface)[0].addresses[0]
  endpoint                    = tolist(libvirt_domain.worker[count.index].network_interface)[0].addresses[0]

  depends_on = [libvirt_domain.worker]
}

resource "talos_machine_bootstrap" "talos" {
  client_configuration = talos_machine_secrets.talos.client_configuration
  node                 = local.controller_ip
  endpoint             = local.controller_ip

  depends_on = [talos_machine_configuration_apply.controller]
}

resource "talos_cluster_kubeconfig" "talos" {
  client_configuration = talos_machine_secrets.talos.client_configuration
  node                 = local.controller_ip
  endpoint             = local.controller_ip

  depends_on = [talos_machine_bootstrap.talos]
}

output "kubeconfig" {
  value     = talos_cluster_kubeconfig.talos.kubeconfig_raw
  sensitive = true
}

output "talosconfig" {
  value     = talos_machine_secrets.talos.client_configuration
  sensitive = true
}

output "worker_ips" {
  value = [
    for d in libvirt_domain.worker :
    tolist(d.network_interface)[0].addresses[0]
  ]
}

output "controller_ip" {
  value = local.controller_ip
}
