import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import RoomBuilder from "./RoomBuilder.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <RoomBuilder />
  </StrictMode>
);
