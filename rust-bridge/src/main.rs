//! Example for usage of the Chat Server E2EE Protocol, connecting to the chat server and receiving incoming
//! messages.
#![expect(unused_crate_dependencies, reason = "Example triggered false positive")]
#![expect(
    clippy::integer_division_remainder_used,
    reason = "Some internal of tokio::select triggers this"
)]
#![expect(
    unreachable_code,
    unused_variables,
    clippy::todo,
    reason = "TODO(LIB-16): Finalise this, then remove me"
)]

use core::cell::RefCell;
use std::{io, rc::Rc};

use anyhow::bail;
use clap::Parser;
use data_encoding::HEXLOWER;
use libthreema::{
    cli::{FullIdentityConfig, FullIdentityConfigOptions},
    common::ClientInfo,
    csp::{
        CspProtocol, CspProtocolContext, CspProtocolInstruction, CspStateUpdate,
        payload::{IncomingPayload, MessageAck, MessageWithMetadataBox, OutgoingFrame, OutgoingPayload},
    },
    csp_e2e::{
        CspE2eProtocol, CspE2eProtocolContextInit,
        contacts::{
            create::{CreateContactsInstruction, CreateContactsResponse},
            lookup::ContactsLookupResponse,
            update::{UpdateContactsInstruction, UpdateContactsResponse},
        },
        message::task::incoming::{
            IncomingMessageInstruction, IncomingMessageLoop, IncomingMessageResponse, IncomingMessageTask,
        },
        reflect::{ReflectInstruction, ReflectResponse},
        transaction::{
            begin::{BeginTransactionInstruction, BeginTransactionResponse},
            commit::{CommitTransactionInstruction, CommitTransactionResponse},
        },
    },
    https::cli::https_client_builder,
    model::provider::in_memory::{DefaultShortcutProvider, InMemoryDb, InMemoryDbInit, InMemoryDbSettings},
    utils::logging::init_stderr_logging,
};
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::TcpStream,
    signal,
    sync::mpsc,
};
use tracing::{Level, debug, error, info, trace, warn};

use libthreema::https::directory::{request_identities, handle_identities_result};
use libthreema::common::config::Flavor;





use std::io::BufRead;

#[derive(serde::Deserialize, Debug)]
#[serde(tag = "type")]
pub enum BridgeInput {
    SendMessage {
        recipient: String,
        text: String,
    }
}

#[derive(serde::Serialize)]
#[serde(tag = "type")]
pub enum BridgeOutput {
    Message {
        sender: String,
        text: String,
        timestamp: u64,
    },
    Unknown {
        sender: String,
        message_type: i32,
        data_hex: String,
        timestamp: u64,
    },
    Log {
        level: String,
        message: String,
    },
    HandshakeComplete,
}

struct LoggingConversationProvider {
    inner: libthreema::model::provider::in_memory::InMemoryDbMessageProvider,
}
impl libthreema::model::provider::ConversationProvider for LoggingConversationProvider {
    fn message_is_marked_used(
        &self,
        sender_identity: libthreema::common::ThreemaId,
        id: libthreema::common::MessageId,
    ) -> Result<bool, libthreema::model::provider::ProviderError> {
        self.inner.message_is_marked_used(sender_identity, id)
    }

    fn set_typing_indicator(
        &mut self,
        sender_identity: libthreema::common::ThreemaId,
        is_typing: bool,
    ) -> Result<(), libthreema::model::provider::ProviderError> {
        self.inner.set_typing_indicator(sender_identity, is_typing)
    }

    fn add_or_update_incoming_message(&mut self, message: libthreema::model::message::IncomingMessage) -> Result<(), libthreema::model::provider::ProviderError> {
        use libthreema::model::message::{IncomingMessageBody, ContactMessageBody, GroupMessageBody};
        match &message.body {
            IncomingMessageBody::Contact(contact_body) => {
                match contact_body {
                    ContactMessageBody::Text(text_msg) => {
                        println!("BRIDGE-JSON: {}", serde_json::to_string(&BridgeOutput::Message {
                            sender: message.sender_identity.to_string(),
                            text: text_msg.text.clone(),
                            timestamp: message.created_at,
                        }).unwrap_or_default());
                    },
                    ContactMessageBody::Unknown { r#type, data } => {
                        println!("BRIDGE-JSON: {}", serde_json::to_string(&BridgeOutput::Unknown {
                            sender: message.sender_identity.to_string(),
                            message_type: *r#type as i32,
                            data_hex: HEXLOWER.encode(data),
                            timestamp: message.created_at,
                        }).unwrap_or_default());
                    },
                    _ => {
                        println!("BRIDGE-JSON: {}", serde_json::to_string(&BridgeOutput::Log { level: "debug".to_string(), message: format!("Provider: other contact message type: {:?}", contact_body.message_type()) }).unwrap_or_default());
                    }
                }
            },
            IncomingMessageBody::Group(group_msg) => {
                match &group_msg.body {
                    GroupMessageBody::Text(text_msg) => {
                        println!("BRIDGE-JSON: {}", serde_json::to_string(&BridgeOutput::Message {
                            sender: format!("*{:x}", group_msg.group_identity.group_id), // Group ID marker
                            text: text_msg.text.clone(),
                            timestamp: message.created_at,
                        }).unwrap_or_default());
                    },
                    GroupMessageBody::Unknown { r#type, data } => {
                        println!("BRIDGE-JSON: {}", serde_json::to_string(&BridgeOutput::Unknown {
                            sender: format!("*{:x}", group_msg.group_identity.group_id),
                            message_type: *r#type as i32,
                            data_hex: HEXLOWER.encode(data),
                            timestamp: message.created_at,
                        }).unwrap_or_default());
                    },
                    _ => {
                        println!("BRIDGE-JSON: {}", serde_json::to_string(&BridgeOutput::Log { level: "debug".to_string(), message: format!("Provider: other group message type: {:?}", group_msg.body.message_type()) }).unwrap_or_default());
                    }
                }
            }
        }
        self.inner.add_or_update_incoming_message(message)
    }
}


#[derive(Parser)]
#[command()]
struct CspE2eReceiveCommand {
    #[command(flatten)]
    config: FullIdentityConfigOptions,
}

enum IncomingPayloadForCspE2e {
    Message(MessageWithMetadataBox),
    MessageAck(MessageAck),
}

enum OutgoingPayloadForCspE2e {
    UnblockIncomingMessages,
    MessageAck(MessageAck),
    MessageWithMetadataBox(MessageWithMetadataBox),
}
impl From<OutgoingPayloadForCspE2e> for OutgoingPayload {
    fn from(payload: OutgoingPayloadForCspE2e) -> Self {
        match payload {
            OutgoingPayloadForCspE2e::MessageAck(message_ack) => OutgoingPayload::MessageAck(message_ack),
            OutgoingPayloadForCspE2e::UnblockIncomingMessages => OutgoingPayload::UnblockIncomingMessages,
            OutgoingPayloadForCspE2e::MessageWithMetadataBox(msg) => OutgoingPayload::MessageWithMetadataBox(msg),
        }
    }
}


/// Payload queues for the main process
struct PayloadQueuesForCspE2e {
    incoming: mpsc::Receiver<IncomingPayloadForCspE2e>,
    outgoing: mpsc::Sender<OutgoingPayloadForCspE2e>,
}

/// Payload queues for the protocol flow runner
struct PayloadQueuesForCsp {
    incoming: mpsc::Sender<IncomingPayloadForCspE2e>,
    outgoing: mpsc::Receiver<OutgoingPayloadForCspE2e>,
}

struct CspProtocolRunner {
    /// The TCP stream
    stream: TcpStream,

    /// An instance of the [`CspProtocol`] state machine
    protocol: CspProtocol,
}
impl CspProtocolRunner {
    /// Initiate a CSP protocol connection and hand out the initial `client_hello` message
    #[tracing::instrument(skip_all)]
    async fn new(
        server_address: Vec<(String, u16)>,
        context: CspProtocolContext,
    ) -> anyhow::Result<(Self, OutgoingFrame)> {
        // Connect via TCP
        debug!(?server_address, "Establishing TCP connection to chat server",);
        let tcp_stream = TcpStream::connect(
            server_address
                .first()
                .expect("CSP config should have at least one address"),
        )
        .await?;

        // Create the protocol
        let (csp_protocol, client_hello) = CspProtocol::new(context);
        Ok((
            Self {
                stream: tcp_stream,
                protocol: csp_protocol,
            },
            client_hello,
        ))
    }

    /// Do the handshake with the chat server by exchanging the following messages:
    ///
    /// ```txt
    /// C -- client-hello -> S
    /// C <- server-hello -- S
    /// C ---- login ---- -> S
    /// C <-- login-ack ---- S
    /// ```
    #[tracing::instrument(skip_all)]
    async fn run_handshake_flow(&mut self, client_hello: OutgoingFrame) -> anyhow::Result<()> {
        // Send the client hello
        debug!(length = client_hello.0.len(), "Sending client hello");
        self.send(&client_hello.0).await?;

        // Handshake by polling the CSP state
        for iteration in 1_usize.. {
            trace!("Iteration #{iteration}");

            // Receive required bytes and add them
            let bytes = self.receive_required().await?;
            self.protocol.add_chunks(&[&bytes])?;

            // Handle instruction
            let Some(instruction) = self.protocol.poll()? else {
                continue;
            };

            // We do not expect an incoming payload at this stage
            if let Some(incoming_payload) = instruction.incoming_payload {
                let message = "Unexpected incoming payload during handshake";
                error!(?incoming_payload, message);
                bail!(message)
            }

            // Send any outgoing frame
            if let Some(frame) = instruction.outgoing_frame {
                self.send(&frame.0).await?;
            }

            // Check if we've completed the handshake
            if let Some(CspStateUpdate::PostHandshake(login_ack_data)) = instruction.state_update {
                info!(?login_ack_data, "Handshake complete");
println!("{}", serde_json::to_string(&BridgeOutput::HandshakeComplete).unwrap());
                break;
            }
        }

        Ok(())
    }

    /// Run the payload exchange flow until stopped.
    #[tracing::instrument(skip_all)]
    async fn run_payload_flow(&mut self, mut queues: PayloadQueuesForCsp) -> anyhow::Result<()> {
        let mut read_buffer = [0_u8; 8192];
        let mut next_instruction: Option<CspProtocolInstruction> = None;

        for iteration in 1_usize.. {
            trace!("Iteration #{iteration}");

            // Poll for an instruction, if necessary
            if next_instruction.is_none() {
                next_instruction = self.protocol.poll()?;
            }

            // Wait for more input, if necessary
            if next_instruction.is_none() {
                next_instruction = tokio::select! {
                    // Forward any incoming chunks from the TCP stream
                    _ = self.stream.readable() => {
                        let length = self.try_receive(&mut read_buffer)?;

                        // Add chunks (poll in the next iteration)
                        self.protocol
                            .add_chunks(&[read_buffer.get(..length)
                            .expect("Amount of read bytes should be available")])?;
                        None
                    },

                    // Forward any outgoing payloads
                    outgoing_payload = queues.outgoing.recv() => {
                        if let Some(outgoing_payload) = outgoing_payload {
                            let outgoing_payload = OutgoingPayload::from(outgoing_payload);
                            debug!(?outgoing_payload, "Sending payload");
                            Some(self.protocol.create_payload(&outgoing_payload)?)
                        } else {
                            break
                        }
                    }
                };
            }

            // Handle instruction
            let Some(current_instruction) = next_instruction.take() else {
                continue;
            };

            // We do not expect any state updates at this stage
            if let Some(state_update) = current_instruction.state_update {
                let message = "Unexpected state update after handshake";
                error!(?state_update, message);
                bail!(message)
            }

            // Handle any incoming payload
            if let Some(incoming_payload) = current_instruction.incoming_payload {
                debug!(?incoming_payload, "Received payload");
                println!("{}", serde_json::to_string(&BridgeOutput::Log { level: "debug".to_string(), message: format!("RAW PAYLOAD: {:?}", incoming_payload) }).unwrap_or_default());
                match incoming_payload {
                    IncomingPayload::EchoRequest(echo_payload) => {
                        // Respond to echo request
                        next_instruction = Some(
                            self.protocol
                                .create_payload(&OutgoingPayload::EchoResponse(echo_payload))?,
                        );
                    },
                    IncomingPayload::MessageWithMetadataBox(payload) => {
                        // Forward message
                        queues
                            .incoming
                            .send(IncomingPayloadForCspE2e::Message(payload))
                            .await?;
                    },
                    IncomingPayload::MessageAck(payload) => {
                        // Forward message ack
                        queues
                            .incoming
                            .send(IncomingPayloadForCspE2e::MessageAck(payload))
                            .await?;
                    },

                    IncomingPayload::EchoResponse(_)
                    | IncomingPayload::QueueSendComplete
                    | IncomingPayload::DeviceCookieChangeIndication
                    | IncomingPayload::CloseError(_)
                    | IncomingPayload::ServerAlert(_)
                    | IncomingPayload::UnknownPayload { .. } => {},
                }
            }

            // Send any outgoing frame
            if let Some(frame) = current_instruction.outgoing_frame {
                self.send(&frame.0).await?;
            }
        }

        Ok(())
    }

    /// Shut down the TCP connection
    #[tracing::instrument(skip_all)]
    async fn shutdown(&mut self) -> anyhow::Result<()> {
        info!("Shutting down TCP connection");
        Ok(self.stream.shutdown().await?)
    }

    /// Send bytes to the server over the TCP connection
    #[tracing::instrument(skip_all, fields(bytes_length = bytes.len()))]
    async fn send(&mut self, bytes: &[u8]) -> anyhow::Result<()> {
        trace!(length = bytes.len(), "Sending bytes");
        self.stream.write_all(bytes).await?;

        Ok(())
    }

    #[tracing::instrument(skip_all)]
    async fn receive_required(&mut self) -> anyhow::Result<Vec<u8>> {
        // Get the minimum amount of bytes we'll need to receive
        let length = self.protocol.next_required_length()?;
        let mut buffer = vec![0; length];
        trace!(?length, "Reading bytes");

        // If there is nothing to read, return immediately
        if length == 0 {
            return Ok(buffer);
        }

        // Read the exact number of bytes required
        let _ = self.stream.read_exact(&mut buffer).await?;

        // Read more if available
        match self.stream.try_read_buf(&mut buffer) {
            Ok(0) => {
                // Remote shut down our reading end gracefully.
                //
                // IMPORTANT: An implementation needs to ensure that it stops gracefully by processing any
                // remaining payloads prior to stopping the protocol. This example implementation ensures this
                // by handling all pending instructions prior to polling for more data. The only case we bail
                // is therefore when our instruction queue is already dry.
                bail!("TCP reading end closed")
            },
            Ok(length) => {
                trace!(length, "Got additional bytes");
            },
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                trace!("No additional bytes available");
            },
            Err(error) => {
                return Err(error.into());
            },
        }
        debug!(length = buffer.len(), "Received bytes");

        Ok(buffer)
    }

    #[tracing::instrument(skip_all)]
    fn try_receive(&mut self, buffer: &mut [u8]) -> anyhow::Result<usize> {
        match self.stream.try_read(buffer) {
            Ok(0) => {
                // Remote shut down our reading end.
                let message = "TCP reading end closed";
                warn!(message);
                bail!(message);
            },
            Ok(length) => {
                debug!(length, "Received bytes");
                Ok(length)
            },
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                trace!("No bytes to receive");
                Ok(0)
            },
            Err(error) => Err(error.into()),
        }
    }
}

struct CspE2eProtocolRunner {
    /// An instance of the [`CspE2eProtocol`] state machine
    protocol: CspE2eProtocol,

    /// HTTP client
    http_client: reqwest::Client,
}
impl CspE2eProtocolRunner {
    #[tracing::instrument(skip_all)]
    fn new(http_client: reqwest::Client, context: CspE2eProtocolContextInit) -> anyhow::Result<Self> {
        Ok(Self {
            protocol: CspE2eProtocol::new(context),
            http_client,
        })
    }

    /// Run the receive flow until stopped.
    #[tracing::instrument(skip_all)]
    async fn run_receive_flow(&mut self, mut queues: PayloadQueuesForCspE2e) -> anyhow::Result<()> {
        let mut pending_task: Option<IncomingMessageTask> = None;

        for iteration in 1_usize.. {
            trace!("Receive flow iteration #{iteration}");

            // Handle any incoming payloads until we have a task
            let Some(task) = &mut pending_task else {
                match queues.incoming.recv().await {
                    Some(IncomingPayloadForCspE2e::Message(message)) => {
                        trace!(message = HEXLOWER.encode(&message.bytes), "Raw incoming message");
                        info!(?message, "Incoming message");
                        pending_task = Some(self.protocol.handle_incoming_message(message));
                    },
                    Some(IncomingPayloadForCspE2e::MessageAck(message_ack)) => {
                        warn!(?message_ack, "Unexpected message-ack");
                    },
                    None => {},
                }
                continue;
            };

            // Handle task
            match task.poll(self.protocol.context())? {
                IncomingMessageLoop::Instruction(IncomingMessageInstruction::FetchSender(instruction)) => {
                    // Run both requests simultaneously
                    let work_directory_request_future = async {
                        match instruction.work_directory_request {
                            Some(work_directory_request) => {
                                work_directory_request.send(&self.http_client).await.map(Some)
                            },
                            None => Ok(None),
                        }
                    };
                    let (directory_result, work_directory_result) = tokio::join!(
                        instruction.directory_request.send(&self.http_client),
                        work_directory_request_future,
                    );

                    // Forward response
                    task.response(IncomingMessageResponse::FetchSender(ContactsLookupResponse {
                        directory_result,
                        work_directory_result: work_directory_result.transpose(),
                    }))?;
                },
                IncomingMessageLoop::Instruction(IncomingMessageInstruction::CreateContact(instruction)) => {
                    match instruction {
                        CreateContactsInstruction::BeginTransaction(instruction) => {
                            // Begin transaction and forward response, if any
                            let response = self.begin_transaction(instruction).await?;
                            if let Some(response) = response {
                                task.response(IncomingMessageResponse::CreateContact(
                                    CreateContactsResponse::BeginTransactionResponse(response),
                                ))?;
                            }
                        },
                        CreateContactsInstruction::ReflectAndCommitTransaction(instruction) => {
                            // Reflect and commit transaction and forward response
                            task.response(IncomingMessageResponse::CreateContact(
                                CreateContactsResponse::CommitTransactionResponse(
                                    self.reflect_and_commit_transaction(instruction).await?,
                                ),
                            ))?;
                        },
                    }
                },
                IncomingMessageLoop::Instruction(IncomingMessageInstruction::UpdateContact(instruction)) => {
                    match instruction {
                        UpdateContactsInstruction::BeginTransaction(instruction) => {
                            // Begin transaction and forward response, if any
                            let response = self.begin_transaction(instruction).await?;
                            if let Some(response) = response {
                                task.response(IncomingMessageResponse::UpdateContact(
                                    UpdateContactsResponse::BeginTransactionResponse(response),
                                ))?;
                            }
                        },
                        UpdateContactsInstruction::ReflectAndCommitTransaction(instruction) => {
                            // Reflect and commit transaction and forward response
                            task.response(IncomingMessageResponse::UpdateContact(
                                UpdateContactsResponse::CommitTransactionResponse(
                                    self.reflect_and_commit_transaction(instruction).await?,
                                ),
                            ))?;
                        },
                    }
                },
                IncomingMessageLoop::Instruction(IncomingMessageInstruction::ReflectMessage(instruction)) => {
                    task.response(IncomingMessageResponse::ReflectMessage(
                        self.reflect(instruction).await?,
                    ))?;
                },

                IncomingMessageLoop::Done(result) => {
                    // Send message acknowledgement, if any
                    if let Some(outgoing_message_ack) = result.outgoing_message_ack {
                        queues
                            .outgoing
                            .send(OutgoingPayloadForCspE2e::MessageAck(outgoing_message_ack))
                            .await?;
                    }
                    pending_task = None;
                },
            }
        }

        Ok(())
    }

    #[tracing::instrument(skip_all)]
    async fn begin_transaction(
        &self,
        instruction: BeginTransactionInstruction,
    ) -> anyhow::Result<Option<BeginTransactionResponse>> {
        match instruction {
            BeginTransactionInstruction::TransactionRejected => {
                // TODO(LIB-16). Await TransactionEnded
                Ok(None)
            },
            BeginTransactionInstruction::BeginTransaction { message } => {
                // TODO(LIB-16). Send `BeginTransaction, await BeginTransactionAck or TransactionRejected,
                // then return BeginTransactionResponse(message)
                Ok(Some(BeginTransactionResponse::BeginTransactionReply(todo!())))
            },
            BeginTransactionInstruction::AbortTransaction { message } => {
                // TODO(LIB-16). Send `CommitTransaction`, await CommitTransactionAck, then return
                // AbortTransaction(CommitTransactionAck)
                Ok(Some(BeginTransactionResponse::AbortTransactionResponse(todo!())))
            },
        }
    }

    #[tracing::instrument(skip_all)]
    async fn reflect_and_commit_transaction(
        &self,
        instruction: CommitTransactionInstruction,
    ) -> anyhow::Result<CommitTransactionResponse> {
        // TODO(LIB-16). Reflect messages, then immediately commit. Await CommitAck and gather any
        // reflect-acks
        Ok(CommitTransactionResponse {
            acknowledged_reflect_ids: todo!(),
            commit_transaction_ack: todo!(),
        })
    }

    #[tracing::instrument(skip_all)]
    async fn reflect(&self, instruction: ReflectInstruction) -> anyhow::Result<ReflectResponse> {
        // TODO(LIB-16). Reflect messages, then wait for corresponding reflect-acks
        Ok(ReflectResponse {
            acknowledged_reflect_ids: todo!(),
        })
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Configure logging
    init_stderr_logging(Level::TRACE);

    // Create HTTP client
    let http_client = https_client_builder().build()?;

    // Parse arguments for command
    let arguments = CspE2eReceiveCommand::parse();
    let config = FullIdentityConfig::from_options(&http_client, arguments.config).await?;

    // Create CSP E2EE protocol context
    let mut database = InMemoryDb::from(InMemoryDbInit {
        user_identity: config.minimal.user_identity,
        settings: InMemoryDbSettings {
            block_unknown_identities: false,
        },
        contacts: vec![],
        blocked_identities: vec![],
    });
    
    let database_contacts = database.contacts.clone();
    let csp_e2e_context = CspE2eProtocolContextInit {
        client_info: ClientInfo::Libthreema,
        config: Rc::clone(&config.minimal.common.config),
        csp_e2e: config.csp_e2e_context_init(Box::new(RefCell::new(database.csp_e2e_nonce_provider()))),
        d2x: config.d2x_context_init(Box::new(RefCell::new(database.d2d_nonce_provider()))),
        shortcut: Box::new(DefaultShortcutProvider),
        settings: Box::new(RefCell::new(database.settings_provider())),
        contacts: {
        Box::new(RefCell::new(database.contact_provider()))
    },
        conversations: Box::new(RefCell::new(LoggingConversationProvider { inner: database.message_provider() })),
    };

    // Create payload queues
    let (csp_e2e_queues, csp_queues) = {
        let incoming_payload = mpsc::channel(4);
        let outgoing_payload = mpsc::channel(4);
        (
            PayloadQueuesForCspE2e {
                incoming: incoming_payload.1,
                outgoing: outgoing_payload.0,
            },
            PayloadQueuesForCsp {
                incoming: incoming_payload.0,
                outgoing: outgoing_payload.1,
            },
        )
    };

    // Create CSP protocol and establish a connection
    let (mut csp_runner, client_hello) = CspProtocolRunner::new(
        config
            .minimal
            .common
            .config
            .chat_server_address
            .addresses(config.csp_server_group),
        config
            .csp_context_init()
            .try_into()
            .expect("Configuration should be valid"),
    )
    .await?;

    // Run the handshake flow
    csp_runner.run_handshake_flow(client_hello).await?;

    
    // Create CSP E2E protocol
    let mut csp_e2e_protocol = CspE2eProtocolRunner::new(http_client.clone(), csp_e2e_context)?;

    // Spawn stdin reader
    let stdin_tx = csp_e2e_queues.outgoing.clone();
    let user_identity = config.minimal.user_identity;
    let client_key = libthreema::common::keys::ClientKey::from(&config.minimal.client_key);
    let contacts_ref = Rc::clone(&database_contacts);
    
    

    let mut stdin_lines = tokio::io::BufReader::new(tokio::io::stdin());
    let mut current_line = String::new();
    println!("{}", serde_json::to_string(&BridgeOutput::Log { level: "info".to_string(), message: "Stdin reader ready".to_string() }).unwrap_or_default());
    
    // Run the protocols
    tokio::select! {
        _ = csp_runner.run_payload_flow(csp_queues) => {},
        _ = csp_e2e_protocol.run_receive_flow(csp_e2e_queues) => {},
        _ = signal::ctrl_c() => {},
        _ = async {
            use tokio::io::AsyncBufReadExt;
            let _ = stdin_tx.send(OutgoingPayloadForCspE2e::UnblockIncomingMessages).await;
            while let Ok(len) = stdin_lines.read_line(&mut current_line).await {
                if len == 0 { break; }
                let trimmed = current_line.trim();
                if trimmed.is_empty() { continue; }
                
                println!("{}", serde_json::to_string(&BridgeOutput::Log { level: "debug".to_string(), message: format!("STDIN RECEIVE: {}", trimmed) }).unwrap_or_default());
                
                match serde_json::from_str::<BridgeInput>(&current_line) {
                    Ok(BridgeInput::SendMessage { recipient, text }) => {
                        if let Ok(receiver_identity) = libthreema::common::ThreemaId::try_from(recipient.as_str()) {
                            // Check if contact exists
                            let contact_opt = {
                                let contacts = database_contacts.borrow();
                                contacts.get(&receiver_identity).map(|(c, _)| c.clone())
                            };
                            
                            let contact = if let Some(c) = contact_opt {
                                Some(c)
                            } else {
                                // Perform Directory Lookup
                                println!("{}", serde_json::to_string(&BridgeOutput::Log { level: "info".to_string(), message: format!("Contact {} not in database, performing directory lookup...", recipient) }).unwrap_or_default());
                                let request = request_identities(
                                    &ClientInfo::Libthreema,
                                    &config.minimal.common.config.directory_server_url,
                                    &config.minimal.common.flavor,
                                    &[receiver_identity],
                                );
                                match handle_identities_result(request.send(&http_client).await) {
                                    Ok(identities) => {
                                        let identities: Vec<libthreema::model::contact::ContactInit> = identities;
                                        if let Some(init) = identities.into_iter().next() {
                                            let new_contact = libthreema::model::contact::Contact::from(init);
                                            // Store in database
                                            database_contacts.borrow_mut().insert(receiver_identity, (new_contact.clone(), None));
                                            Some(new_contact)
                                        } else {
                                            println!("{}", serde_json::to_string(&BridgeOutput::Log { level: "error".to_string(), message: format!("Recipient {} not found in Threema directory", recipient) }).unwrap_or_default());
                                            None
                                        }
                                    },
                                    Err(e) => {
                                        println!("{}", serde_json::to_string(&BridgeOutput::Log { level: "error".to_string(), message: format!("Directory lookup failed for {}: {}", recipient, e) }).unwrap_or_default());
                                        None
                                    }
                                }
                            };

                            if let Some(contact) = contact {
                                let shared_secret = client_key.derive_csp_e2e_key(&contact.public_key);
                                
                                let message = libthreema::model::message::OutgoingMessage {
                                    id: libthreema::common::MessageId::random(),
                                    overrides: libthreema::model::message::MessageOverrides::default(),
                                    created_at: (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64),
                                    body: libthreema::model::message::OutgoingMessageBody::Contact(
                                        libthreema::model::message::OutgoingContactMessageBody {
                                            receiver_identity,
                                            body: libthreema::model::message::ContactMessageBody::Text(
                                                libthreema::model::message::TextMessage { text }
                                            )
                                        }
                                    )
                                };
                                
                                let outgoing_box = libthreema::csp_e2e::message::task::outgoing::encode_and_encrypt_message(
                                    user_identity,
                                    (None, libthreema::common::Delta::Update("Stephans digitaler Assistent")),
                                    receiver_identity,
                                    shared_secret,
                                    &message,
                                    libthreema::common::Nonce::random(),
                                );
                                
                                if let Ok(msg_box) = libthreema::csp::payload::MessageWithMetadataBox::try_from(outgoing_box) {
                                    let _ = stdin_tx.send(OutgoingPayloadForCspE2e::MessageWithMetadataBox(msg_box)).await;
                                }
                            }
                        }
                    },
                    Err(e) => {
                        println!("{}", serde_json::to_string(&BridgeOutput::Log { level: "error".to_string(), message: format!("JSON parse error: {}", e) }).unwrap_or_default());
                    }
                }
                current_line.clear();
            }
        } => {}
    };

    // Shut down
    csp_runner.shutdown().await?;
    Ok(())
}

#[test]
fn verify_cli() {
    use clap::CommandFactory;
    CspE2eReceiveCommand::command().debug_assert();
}
