# Builds the docker image and pushes to ECR. Triggered on changes to any
# Clojure source, the Dockerfile, or the build script.
#
# Force a rebuild without source changes: bump local.image_tag in main.tf
# or run `terraform apply -replace=null_resource.docker_build_push`.

locals {
  workshop_dir = "${path.module}/../.."
  parent_dir   = "${path.module}/../../.."

  source_hashes = {
    dockerfile      = filemd5("${local.workshop_dir}/Dockerfile")
    workshop_deps   = filemd5("${local.workshop_dir}/deps.edn")
    workshop_server = filemd5("${local.workshop_dir}/clj/rigging_workshop/server.clj")
    workshop_bb     = filemd5("${local.workshop_dir}/clj/rigging_workshop/server_bb.clj")
    build_script    = filemd5("${path.module}/build.sh")
  }
}

resource "null_resource" "docker_build_push" {
  triggers = merge(local.source_hashes, {
    image_tag = local.image_tag
    ecr_url   = module.ecr.repository_url
  })

  provisioner "local-exec" {
    command     = "${path.module}/build.sh ${module.ecr.repository_url} ${local.image_tag} ${local.aws_region}"
    interpreter = ["bash", "-c"]
  }

  depends_on = [module.ecr]
}
