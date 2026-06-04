//! Rendering — a pure function of `&App`. No state mutation here, so views can
//! be snapshot-tested against a ratatui `TestBackend`.

use crate::app::App;
use ratatui::{
    layout::{Constraint, Direction, Layout},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

pub fn draw(f: &mut Frame, app: &App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(1), Constraint::Length(1)])
        .split(f.area());

    let body = Paragraph::new("Papercusp terminal workbench\n\n(P0 skeleton — panels land in P1)")
        .block(Block::default().borders(Borders::ALL).title(" pui "));
    f.render_widget(body, chunks[0]);

    let status = Paragraph::new(app.status.as_str());
    f.render_widget(status, chunks[1]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{backend::TestBackend, Terminal};

    #[test]
    fn renders_title_and_status() {
        let app = App::new();
        let mut term = Terminal::new(TestBackend::new(60, 10)).unwrap();
        term.draw(|f| draw(f, &app)).unwrap();
        let buf = term.backend().buffer().clone();
        let text: String = buf.content().iter().map(|c| c.symbol()).collect();
        assert!(text.contains("pui"), "title should render");
        assert!(text.contains("Papercusp"), "body should render");
        assert!(text.contains("quit"), "status line should render");
    }
}
