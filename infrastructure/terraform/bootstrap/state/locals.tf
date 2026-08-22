locals {
  primary_region = "europe-west1"

  state_bucket_labels = {
    application = "skyos"
    environment = "nonprod"
    component   = "terraform-state"
  }
}
