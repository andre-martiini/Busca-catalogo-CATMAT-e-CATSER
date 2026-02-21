
export interface ServiceItem {
  tipo: string;
  grupoCodigo: string;
  grupoDescricao: string;
  classeCodigo: string;
  classeDescricao: string;
  codigoServico: string;
  descricaoServico: string;
  situacao: string;
}

export interface MaterialItem {
  tipo: string;
  grupoCodigo: string;
  grupoDescricao: string;
  classeCodigo: string;
  classeDescricao: string;
  pdmCodigo?: string;
  pdmDescricao?: string;
  codigoMaterial: string;
  descricaoMaterial: string;
  ncmCodigo?: string;
  situacao: string;
}

export type AppView = 'menu' | 'catser' | 'catmat';

export interface SortConfig {
  key: string;
  direction: 'asc' | 'desc' | null;
}
