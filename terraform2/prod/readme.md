# rigchecker — prod terraform

Deploys both Clojure servers (`clj -M:server` on 7878, `clj -M:server-bb` on 7879)
to a single ECS Fargate task (ARM64 / Graviton), fronted by an ALB with
ACM-issued HTTPS at `https://rigchecker.todaq.net`.

Layout follows toda-relay's `infrastructure/<env>/main.tf` + `infrastructure/modules/<name>/main.tf` pattern.

## Traffic flow

```
client → Route53 (rigchecker.todaq.net A-alias) → ALB :443 → Fargate task → JVM:7878 or :7879
client : 80 → ALB :80 redirects to :443
```

ALB routing rules:
- `/rigcheck-clj`, `/rigcheck-clj/*` → main container (7878)
- `/rigcheck-bb`,  `/rigcheck-bb/*`  → bb container   (7879)
- everything else → main container (default action)

## One-time bootstrap

The S3 state bucket has to exist before `terraform init` can use it.
Create it once, by hand:

```bash
aws s3api create-bucket \
  --bucket rigchecker-terraform-state \
  --region us-east-1

aws s3api put-bucket-versioning \
  --bucket rigchecker-terraform-state \
  --versioning-configuration Status=Enabled

aws s3api put-public-access-block \
  --bucket rigchecker-terraform-state \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicAccess=true

aws s3api put-bucket-encryption \
  --bucket rigchecker-terraform-state \
  --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
```

State locking uses S3 conditional writes (`use_lockfile = true`), no DynamoDB needed.
Requires terraform 1.11+.

## Prerequisites

- AWS credentials in the shell (`aws sso login` / `AWS_PROFILE=…`)
- `terraform` >= 1.11
- `docker` running locally
- `rsync`, `bash`, `aws` CLI on PATH
- `clojure` CLI on PATH; brew openjdk@21 installed (build.sh exports JAVA_HOME to it)
- Sibling repos next to `rigging-workshop/`:
  - `../toda-clj/`
  - `../toda-bb/`
- A Route53 hosted zone for `todaq.net.` already in this AWS account

## Deploy

```bash
cd terraform2/prod
terraform init
terraform plan -out=apply.plan
terraform apply apply.plan
```

First apply is ~5–10 min: ACM cert issuance + DNS validation, ALB warm-up,
docker build + ECR push, ECS pulls + health checks pass.

`terraform output public_url` should print `https://rigchecker.todaq.net`.

## Updating

Source changes under `Dockerfile`, `deps.edn`, or `clj/rigging_workshop/*.clj`
re-trigger the build via `filemd5` hashes in `build.tf`. To force a rebuild
without source changes:

```bash
terraform apply -replace=null_resource.docker_build_push
```

ECS picks up the new image because `force_new_deployment = true` on the service.

## Tearing down

```bash
terraform destroy
```

ECR has `force_delete = true`, so the repo + images get removed with the rest.
The state bucket and its contents are *not* destroyed — they were created
out-of-band and can be `aws s3 rb --force` deleted by hand if you really want to.

## Caveats

- One Fargate task, `desired_count = 1`. No autoscaling. Both JVMs share the
  task's CPU/memory budget (1 vCPU / 2 GiB by default — bump `task_cpu` /
  `task_memory` in `main.tf` if either JVM gets OOM-killed).
- `assign_public_ip = true` on the service so the task can pull from ECR via
  the default VPC's IGW without NAT.
- `enable_execute_command = true` on the service — `aws ecs execute-command`
  works for shelling into a running container.
- ARM64 architecture: the Docker build runs `--platform=linux/arm64`. On
  M-series Macs this is native; on x86 hosts it'll use qemu emulation and
  be slow but still correct.
