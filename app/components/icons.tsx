import {
  ChevronDownSmall,
  ChevronRight,
  ChevronLeftSmall,
  MagnifyingGlass,
  Calendar,
  Clock,
  ClockDashed,
  Globe,
  Lightning,
  Terminal,
  Message,
  Wrench,
  Coins,
  Copy,
  External,
  Plus,
  Play,
  StopCircle,
  FolderClosed,
  LoaderCircle,
  GridSquare,
  CloudUpload,
} from "vercel-geist-icons";

export const I = {
  chevDown: <ChevronDownSmall />,
  chevRight: <ChevronRight />,
  search: <MagnifyingGlass />,
  calendar: <Calendar />,
  clock: <Clock />, // plain ring — turn stat bars
  clockDashed: <ClockDashed />, // dashed — table trigger cells
  globe: <Globe />,
  bolt: <Lightning />,
  chevLeft: <ChevronLeftSmall />,
  grid: <GridSquare />,
  terminal: <Terminal />,
  message: <Message />,
  wrench: <Wrench />,
  coins: <Coins />,
  copy: <Copy />,
  external: <External />,
  plus: <Plus />,
  play: <Play />,
  stop: <StopCircle />,
  folder: <FolderClosed />,
  loader: <LoaderCircle />,
  upload: <CloudUpload />,
};

export const triggerIcon = (t: string | null | undefined) =>
  t === "schedule"
    ? I.clockDashed
    : t === "http"
      ? I.globe
      : (t ?? "").startsWith("channel")
        ? I.message
        : I.bolt;
