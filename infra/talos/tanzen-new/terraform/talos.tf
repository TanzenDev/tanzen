resource "talos_machine_secrets" "talos" {}

locals {
  controller_ip = cidrhost(var.cluster_network, 80)
  worker_ips    = [for i in range(var.worker_count) : cidrhost(var.cluster_network, 90 + i)]
}

data "talos_machine_configuration" "controller" {
  cluster_name       = var.cluster_name
  cluster_endpoint   = var.cluster_endpoint
  machine_type       = "controlplane"
  machine_secrets    = talos_machine_secrets.talos.machine_secrets
  talos_version      = "v${var.talos_version}"
  kubernetes_version = var.kubernetes_version

  config_patches = [
    yamlencode({
      machine = {
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
            name     = "cilium"
            contents = join("---\n", [data.helm_template.cilium.manifest, local.cilium_lb_manifest])
          },
          {
            name = "kubelet-serving-cert-approver"
            contents = join("\n---\n", [
              yamlencode({
                apiVersion = "v1"
                kind       = "ServiceAccount"
                metadata   = { name = "kubelet-serving-cert-approver", namespace = "kube-system" }
              }),
              yamlencode({
                apiVersion = "rbac.authorization.k8s.io/v1"
                kind       = "ClusterRole"
                metadata   = { name = "kubelet-serving-cert-approver" }
                rules = [{
                  apiGroups = ["certificates.k8s.io"]
                  resources = ["certificatesigningrequests"]
                  verbs     = ["get", "list", "watch"]
                }, {
                  apiGroups = ["certificates.k8s.io"]
                  resources = ["certificatesigningrequests/approval"]
                  verbs     = ["update"]
                }, {
                  apiGroups     = ["certificates.k8s.io"]
                  resources     = ["signers"]
                  resourceNames = ["kubernetes.io/kubelet-serving"]
                  verbs         = ["approve"]
                }]
              }),
              yamlencode({
                apiVersion = "rbac.authorization.k8s.io/v1"
                kind       = "ClusterRoleBinding"
                metadata   = { name = "kubelet-serving-cert-approver" }
                roleRef    = { apiGroup = "rbac.authorization.k8s.io", kind = "ClusterRole", name = "kubelet-serving-cert-approver" }
                subjects   = [{ kind = "ServiceAccount", name = "kubelet-serving-cert-approver", namespace = "kube-system" }]
              }),
              yamlencode({
                apiVersion = "apps/v1"
                kind       = "Deployment"
                metadata   = { name = "kubelet-serving-cert-approver", namespace = "kube-system" }
                spec = {
                  replicas = 1
                  selector = { matchLabels = { app = "kubelet-serving-cert-approver" } }
                  template = {
                    metadata = { labels = { app = "kubelet-serving-cert-approver" } }
                    spec = {
                      serviceAccountName = "kubelet-serving-cert-approver"
                      containers = [{
                        name  = "kubelet-serving-cert-approver"
                        image = "ghcr.io/alex1989hu/kubelet-serving-cert-approver:latest"
                        args  = ["serve"]
                      }]
                    }
                  }
                }
              })
            ])
          },
          {
            name = "runtimeclass-kata"
            contents = yamlencode({
              apiVersion = "node.k8s.io/v1"
              kind       = "RuntimeClass"
              metadata   = { name = "kata" }
              handler    = "kata"
            })
          },
          {
            name = "runtimeclass-spin"
            contents = yamlencode({
              apiVersion = "node.k8s.io/v1"
              kind       = "RuntimeClass"
              metadata   = { name = "wasmtime-spin-v2" }
              handler    = "spin"
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
  talos_version      = "v${var.talos_version}"
  kubernetes_version = var.kubernetes_version

  config_patches = [
    yamlencode({
      machine = {
        kubelet = {
          extraArgs = { "rotate-server-certificates" = "true" }
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
