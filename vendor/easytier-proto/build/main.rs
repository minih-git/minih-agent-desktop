mod flags;
mod rpc;

use crate::rpc::ServiceGenerator;
use std::{env, path::PathBuf};

fn ensure_protoc() {
    if let Some(path) = env::var_os("PROTOC").map(PathBuf::from) {
        if path.exists() {
            return;
        }
    }
    if let Ok(protoc_path) = protoc_bin_vendored::protoc_bin_path() {
        unsafe {
            env::set_var("PROTOC", protoc_path);
        }
    }
}

fn main() -> anyhow::Result<()> {
    ensure_protoc();

    let proto_files_reflect = ["proto/peer_rpc.proto", "proto/common.proto"];

    let proto_files = [
        "proto/core_peer.proto",
        "proto/core_config.proto",
        "proto/error.proto",
        "proto/tests.proto",
        "proto/api_instance.proto",
        "proto/api_logger.proto",
        "proto/api_config.proto",
        "proto/api_manage.proto",
        "proto/web.proto",
        "proto/magic_dns.proto",
        "proto/acl.proto",
    ];

    for proto_file in proto_files.iter().chain(proto_files_reflect.iter()) {
        println!("cargo:rerun-if-changed={proto_file}");
    }

    let out = PathBuf::from(env::var("OUT_DIR")?);

    let mut config = prost_build::Config::new();
    if env::var_os("CARGO_FEATURE_JSON_RPC").is_some() {
        config
            .extern_path(".google.protobuf.Any", "::prost_wkt_types::Any")
            .extern_path(".google.protobuf.Timestamp", "::prost_wkt_types::Timestamp")
            .extern_path(".google.protobuf.Value", "::prost_wkt_types::Value");
    } else {
        config
            .extern_path(".google.protobuf.Any", "::prost_types::Any")
            .extern_path(".google.protobuf.Timestamp", "::prost_types::Timestamp")
            .extern_path(".google.protobuf.Value", "::prost_types::Value");
    }
    config
        .file_descriptor_set_path(out.join("descriptors.bin"))
        .service_generator(Box::new(ServiceGenerator::default()))
        .btree_map(["."])
        .skip_debug([
            ".common.Ipv4Addr",
            ".common.Ipv6Addr",
            ".common.UUID",
            ".api.manage.ManagedCredentialConfig",
            ".api.manage.VpnPortalConfig",
        ])
        .type_attribute(
            ".common.CompressionAlgoPb",
            "#[derive(strum::EnumString, strum::Display)]",
        )
        .type_attribute(
            ".common.CompressionAlgoPb",
            "#[strum(ascii_case_insensitive)]",
        )
        .field_attribute(".common.CompressionAlgoPb.Invalid", "#[strum(disabled)]");

    let mut descriptor_set = config.load_fds(&proto_files, &["proto/"])?;
    // What protoc wrote (this set carries every file, imports included), read
    // before anything else may touch it: the annotations are extension fields,
    // which a prost-types round-trip drops.
    let annotated = std::fs::read(out.join("descriptors.bin"))?;

    {
        let common = descriptor_set
            .file
            .iter_mut()
            .find(|file| file.package.as_deref() == Some("common"))
            .unwrap();
        let flags = common
            .message_type
            .iter()
            .find(|message| message.name.as_deref() == Some("Flags"))
            .unwrap();
        config
            .type_attribute(".common.Flags", "#[optionize::optionized]")
            .type_attribute(".common.Flags", "#[optionize(object = FlagsPatch)]");

        let flattened = flags
            .field
            .iter()
            .filter(|field| field.proto3_optional())
            .map(|field| field.name().to_owned());
        for name in flattened {
            config.field_attribute(format!(".common.Flags.{name}"), "#[optionize(flatten)]");
        }

        let mut patch = flags.clone();
        patch.name = Some("FlagsPatch".to_owned());
        // Proto3 spells `optional` as one synthetic one-of per field.
        let oneofs = patch
            .field
            .iter()
            .map(|field| prost_types::OneofDescriptorProto {
                name: Some(format!("_{}", field.name())),
                ..Default::default()
            })
            .collect::<Vec<_>>();
        patch.oneof_decl = oneofs;
        for (index, field) in patch.field.iter_mut().enumerate() {
            field.proto3_optional = Some(true);
            field.label = Some(prost_types::field_descriptor_proto::Label::Optional as i32);
            field.oneof_index = Some(index as i32);
        }
        common.message_type.push(patch);

        config.disable_comments([".common.FlagsPatch"]);
    }

    let descriptors = prost::Message::encode_to_vec(&descriptor_set);

    config.file_descriptor_set_path(out.join("file_descriptor_set.bin"));
    config.compile_protos(&proto_files_reflect, &["proto/"])?;
    config.compile_fds(descriptor_set)?;
    flags::write(&annotated, &out)?;

    pbjson_build::Builder::new()
        .register_descriptors(&descriptors)?
        .preserve_proto_field_names()
        .btree_map(["."])
        .build(&["."])?;

    Ok(())
}
