import CameraFeed from "@/components/CameraFeed";

export default function Home() {
  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold text-center mb-8">Camera Vision AI</h1>
      <CameraFeed />
    </div>
  );
}