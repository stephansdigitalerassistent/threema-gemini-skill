use libthreema::{
    common::{ClientInfo, ThreemaId},
    https::{cli::https_client_builder, directory},
};
use std::rc::Rc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let http_client = https_client_builder().build()?;
    let my_id = ThreemaId::try_from("A62B5XJ3")?;
    
    let request = directory::request_identities(
        &ClientInfo::Libthreema,
        &libthreema::common::config::Config::production().directory_server_url,
        &libthreema::csp_e2e::Flavor::Consumer,
        &[my_id],
    );
    
    let identities = directory::handle_identities_result(request.send(&http_client).await)?;
    if let Some(identity) = identities.first() {
        println!("ID: {}", identity.identity);
        println!("Feature Mask: 0x{:x}", identity.feature_mask.0);
    } else {
        println!("Identity not found");
    }
    Ok(())
}
