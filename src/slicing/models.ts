export interface SlicingSettings {
  printer?: string;
  preset?: string;
  filament?: string;
  bedType?: string;
  plate?: string;
  multicolorOnePlate?: boolean;
  arrange?: boolean;
  orient?: boolean;
  exportType?: "gcode" | "3mf";
}

export interface SliceResult {
  gcodes: string[];
  workdir: string;
}

export type Category = "printers" | "presets" | "filaments";
