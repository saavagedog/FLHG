import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

function App() {
  const navigate = useNavigate();

  useEffect(() => {
    const raw = localStorage.getItem("user");
    if (raw) {
      navigate("/onboard");
      return;
    }
    if (!raw) {
      navigate("/login");
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      const hasEmail = parsed && typeof parsed.email === "string" && parsed.email.length > 0;
      const hasPassword = parsed && typeof parsed.password === "string" && parsed.password.length > 0;
      if (!hasEmail || !hasPassword) {
        navigate("/login");
        return;
      }
    } catch {
      localStorage.removeItem("user");
      navigate("/login");
      return;
    }
  }, [navigate]);

  return (
    <div className="flex h-screen items-center justify-center bg-black text-sm text-gray-300">
      Loading launcher...
    </div>
  );
}

export default App;
