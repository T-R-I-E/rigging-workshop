# Rigging Workshop — AWS Deployment

Deploys both Clojure servers (`clj -M:server` on 7878, `clj -M:server-bb` on 7879)
to a single ECS Fargate task. Traffic flows:

```
client → CloudFront (HTTPS, *.cloudfront.net cert) → ALB (HTTP) → task
```

CloudFront terminates TLS using the managed default certificate (no domain needed). The ALB security group only accepts traffic from CloudFront's managed prefix list, so direct ALB hits are blocked.

## Routing (at the ALB)

- `/rigcheck-clj`, `/rigcheck-clj/*` → main container (7878)
- `/rigcheck-bb`,  `/rigcheck-bb/*`  → bb container   (7879)
- everything else → main container: `/compile`, `/decompile`, `/health`, `/spec`

CloudFront forwards every path through to the ALB (no caching, all HTTP methods).

## Prerequisites

- AWS credentials in the shell (e.g. `aws sso login`); the default VPC must exist in the target region.
- `terraform` >= 1.5
- `docker` running locally (the build runs on your machine and pushes to ECR)
- `rsync`, `bash`, `aws` CLI on PATH
- `clojure` CLI on PATH (build.sh runs `clojure -X:deps prep` on the host so `toda-core`'s Java sources get compiled before staging — the image doesn't ship `git`, which prep's `git-count-revs` needs)
- Sibling repos checked out next to `rigging-workshop/`:
  - `../toda-clj/` (contains `toda-core`, `toda-twist-maker`, `toda-rig-checker`)
  - `../toda-bb/`

## Deploy

```bash
cd terraform
terraform init
terraform apply
```

Outputs include `alb_url`. First apply takes a few minutes — image build + push, then ECS pulls and health-checks.

## Updating

Source changes under `Dockerfile`, `deps.edn`, or `clj/rigging_workshop/*.clj` retrigger the build via `filemd5` hashes in `build.tf`. To force a rebuild without source changes, either bump `image_tag` or:

```bash
terraform apply -replace=null_resource.docker_build_push
```

ECS picks up the new image because `force_new_deployment = true` on the service.

## Tearing down

```bash
terraform destroy
```

ECR has `force_delete = true`, so the repo + images get removed with the rest.

## Notes / caveats

- HTTP only on :80. Add ACM + Route53 + an HTTPS listener when you have a domain.
- One Fargate task, `desired_count = 1`. No autoscaling. Both JVMs share the task's CPU/memory budget (defaults: 1 vCPU / 2 GiB — bump `task_cpu` / `task_memory` if either JVM gets OOM-killed).
- `assign_public_ip = true` on the service so the task can pull from ECR via the default VPC's IGW without NAT.
- The build script vendors `toda-clj/` and `toda-bb/` from `../` into a temp staging dir before `docker build`, so the build context stays small and the daemon doesn't see unrelated siblings.
- `enable_execute_command = true` on the service — use `aws ecs execute-command` to shell into a running container for debugging.
