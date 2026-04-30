locals {
  cilium_lb_manifests = [
    {
      apiVersion = "cilium.io/v2alpha1"
      kind       = "CiliumL2AnnouncementPolicy"
      metadata   = { name = "external" }
      spec = {
        loadBalancerIPs = true
        interfaces      = [var.node_iface]
        nodeSelector = {
          matchExpressions = [{
            key      = "node-role.kubernetes.io/control-plane"
            operator = "DoesNotExist"
          }]
        }
      }
    },
    {
      apiVersion = "cilium.io/v2alpha1"
      kind       = "CiliumLoadBalancerIPPool"
      metadata   = { name = "external" }
      spec = {
        blocks = [{
          start = cidrhost(var.cluster_network, var.lb_first_hostnum)
          stop  = cidrhost(var.cluster_network, var.lb_last_hostnum)
        }]
      }
    },
  ]
  cilium_lb_manifest = join("---\n", [for d in local.cilium_lb_manifests : yamlencode(d)])
}

data "helm_template" "cilium" {
  namespace    = "kube-system"
  name         = "cilium"
  repository   = "https://helm.cilium.io"
  chart        = "cilium"
  version      = var.cilium_version
  kube_version = var.kubernetes_version
  api_versions = []

  set {
    name  = "ipam.mode"
    value = "kubernetes"
  }
  set {
    name  = "securityContext.capabilities.ciliumAgent"
    value = "{CHOWN,KILL,NET_ADMIN,NET_RAW,IPC_LOCK,SYS_ADMIN,SYS_RESOURCE,DAC_OVERRIDE,FOWNER,SETGID,SETUID}"
  }
  set {
    name  = "securityContext.capabilities.cleanCiliumState"
    value = "{NET_ADMIN,SYS_ADMIN,SYS_RESOURCE}"
  }
  set {
    name  = "cgroup.autoMount.enabled"
    value = "false"
  }
  set {
    name  = "cgroup.hostRoot"
    value = "/sys/fs/cgroup"
  }
  set {
    name  = "k8sServiceHost"
    value = "localhost"
  }
  set {
    name  = "k8sServicePort"
    value = tostring(var.kubeprism_port)
  }
  set {
    name  = "kubeProxyReplacement"
    value = "true"
  }
  set {
    name  = "l2announcements.enabled"
    value = "true"
  }
  set {
    name  = "devices"
    value = "{${var.node_iface}}"
  }
  set {
    name  = "ingressController.enabled"
    value = "true"
  }
  set {
    name  = "ingressController.default"
    value = "true"
  }
  set {
    name  = "ingressController.loadbalancerMode"
    value = "shared"
  }
  set {
    name  = "ingressController.enforceHttps"
    value = "false"
  }
  set {
    name  = "envoy.enabled"
    value = "true"
  }
  set {
    name  = "hubble.relay.enabled"
    value = "true"
  }
  set {
    name  = "hubble.ui.enabled"
    value = "true"
  }
  set {
    name  = "operator.replicas"
    value = "1"
  }
  # Kata: socket-level LB must not intercept inside the Kata VM network namespace.
  # https://docs.cilium.io/en/stable/network/kubernetes/kata/
  set {
    name  = "socketLB.hostNamespaceOnly"
    value = "true"
  }
}
