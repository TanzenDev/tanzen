# Assorted fixes

A few assorted issues that need attention.

If any of these are just a bad idea, say so.

Break this into a series of plans if useful.

## OpenAPI docs with Scalar

* Add Scalar docs for the API. 

## Fiberplane

* Is it worth it as a debugging tool?

* Is it only for dev? If not, how is it secured in prod?

## Graphiti

* [defaults](https://github.com/getzep/graphiti) to OpenAI but supports other LLMs. 

* It's currently disabled pending an OpenAI API key.

* Try Google Gemini Flash 2.5 with the api key in ../API_KEY

## Tanzen Needs a Build

Can we get a build that builds each component and also "everything". Can be make. If there's a better alternative, explain why.

## Workflow Visual Bug

* Copying and pasting a node is broken in the React Flow editor.

## Transient Audit Log

The audit log in tanzen-enterprise is transient. Rows disappear. Is this stored in Redis instead of Postgres or some other ephemeral location?

## Observability

We have Grafana, Prometheus, and Hubble. These are all infrastructure focused.

Users are flying blind when it comes to their data and the workflows. We don't have the o11y tools and the ones we have aren't exposed/accessible to users.

* Evaluate whether there is an OSS, performant, usable o11y tool available for each of these and whether the effort and resources of including it is worthwhile:
  
  * Redis
  
  * Postgres
  
  * Temporal
  
  * Kubernetes
  
  * SeaweedFS
  
  * Something else

* Should we surface these tools
  
  * To anyone using the OSS core?
  
  * To users with the "admin" role in Enterprise?
  
  * Something else?

* Can we expose (k8s services, etc) these services and protect them with auth (OIDC) in the Enterprise product?
  
  * For Kind
  
  * For Talos ( note we can use Cilium L2 announcement in this context ) simplifying service visibility outside the cluster.

## Clean up Talos

In infra/talos

* There is a tanzen-new directory containing a "terraform" directory.

* There is another terraform directory next to tanzen-new.

* This is copied from ~/dev/ on tanzen0, accessible by passwordless ssh.

* Establish which terraform set is canonical (running on tanzen0)

* Rename or get rid of tanzen-new.

* Check for any hard coded values that need to be variables.

* Get anything from tanzen0 required to run this repeatably that may have been missed.

## Documentation

Plan documentation.

- Is there a better approach than Docusaurus?

- Can we host docs with GitHub pages?

- How do we prevent or minimize document drift, i.e. docs becoming outdated relative to the code?

- We need to address these personae:
  
  - Users
  
  - Administrators (i.e. of Orgs)
  
  - System Administrators

- How do we consistently separate or label "Enterprise" vs "OSS" content?

## Cap Temporal Activity Artifact Storage

It's recommended that activities producing large objects store them in object storage and return an id to avoid maxing out Temporal's artifact storage.

- Can the maximum size Temporal allows be configured to enforce this practice?

- Is this problematic?




