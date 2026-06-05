use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct HttpRequestService {
    cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl HttpRequestService {
    pub fn begin(&self, request_id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut cancellations = self
            .cancellations
            .lock()
            .map_err(|_| "HTTP 请求状态锁定失败。".to_string())?;
        let token = Arc::new(AtomicBool::new(false));
        cancellations.insert(request_id.to_string(), Arc::clone(&token));
        Ok(token)
    }

    pub fn cancel(&self, request_id: &str) -> Result<(), String> {
        let cancellations = self
            .cancellations
            .lock()
            .map_err(|_| "HTTP 请求状态锁定失败。".to_string())?;

        if let Some(token) = cancellations.get(request_id) {
            token.store(true, Ordering::Relaxed);
        }

        Ok(())
    }

    pub fn finish(&self, request_id: &str) {
        if let Ok(mut cancellations) = self.cancellations.lock() {
            cancellations.remove(request_id);
        }
    }
}
