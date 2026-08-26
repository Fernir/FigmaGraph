//! figmagraph-core — fast Layout IR + SQLite index (native kernel).

mod ir;
mod index;

use clap::{Parser, Subcommand};
use serde_json::json;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "figmagraph-core", version)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Build SQLite + Layout IR from .figmagraph/raw/document.json
    Index {
        #[arg(long)]
        index_dir: PathBuf,
        #[arg(long)]
        name: String,
        #[arg(long)]
        source: String,
        #[arg(long)]
        file_key: Option<String>,
    },
    /// Compile Layout IR for one node (fast path for explore / getFullIR)
    Ir {
        #[arg(long)]
        index_dir: PathBuf,
        #[arg(long)]
        node_id: String,
        #[arg(long)]
        max_depth: Option<i32>,
    },
}

fn main() {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Index {
            index_dir,
            name,
            source,
            file_key,
        } => match index::run_index(&index_dir, &name, &source, file_key.as_deref()) {
            Ok((node_count, root_count)) => {
                println!(
                    "{}",
                    json!({ "ok": true, "nodeCount": node_count, "rootCount": root_count })
                );
            }
            Err(e) => {
                eprintln!("figmagraph-core error: {e}");
                std::process::exit(1);
            }
        },
        Cmd::Ir {
            index_dir,
            node_id,
            max_depth,
        } => match index::run_compile_ir(&index_dir, &node_id, max_depth) {
            Ok(ir) => {
                println!("{}", serde_json::to_string(&ir).unwrap_or_else(|_| "{}".into()));
            }
            Err(e) => {
                eprintln!("figmagraph-core error: {e}");
                std::process::exit(1);
            }
        },
    }
}
