import CameraFeed from "@/components/CameraFeed";
export default function Home() {
  return (
    <div className="h-full flex flex-col items-center p-1 pt-12">
      <div className="flex-1 w-full max-w-7xl flex items-center justify-center overflow-hidden">
        <CameraFeed />
      </div>
    </div>
  );
}