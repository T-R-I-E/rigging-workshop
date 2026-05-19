# Builds the docker image and pushes to ECR. Triggered on changes to any
# Clojure source or Dockerfile under the workshop or vendored repos.
#
# To force a rebuild without source changes, bump var.image_tag or run
# `terraform taint null_resource.docker_build_push`.

locals {
  workshop_dir = "${path.module}/.."
  parent_dir   = "${path.module}/../.."

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
    image_tag = var.image_tag
    ecr_url   = aws_ecr_repository.app.repository_url
  })

  provisioner "local-exec" {
    command     = "${path.module}/build.sh ${aws_ecr_repository.app.repository_url} ${var.image_tag} ${var.region}"
    interpreter = ["bash", "-c"]
  }

  depends_on = [aws_ecr_repository.app]
}
