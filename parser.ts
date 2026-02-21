
import { ServiceItem, MaterialItem } from './types';
import * as XLSX from 'xlsx';

/**
 * Limpa o texto de forma eficiente e remove artefatos de codificação comuns
 */
const cleanText = (val: any): string => {
  if (val === null || val === undefined) return '';
  const str = String(val);
  return str
    .replace(/^'/, '') // Remove aspa inicial de exportação Excel
    .replace(/\s+/g, ' ') // Remove espaços extras e quebras de linha
    .trim();
};

export const parseFile = (data: ArrayBuffer, isMaterial: boolean): any[] => {
  try {
    // Lemos o arquivo completo. O modo 'array' é necessário para ArrayBuffer.
    // REMOVIDO: bookSheets: true (isso impedia a leitura das linhas)
    const workbook = XLSX.read(data, { 
      type: 'array',
      cellDates: false,
      cellNF: false,
      cellText: false
    });
    
    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      console.error("Arquivo Excel sem planilhas detectadas.");
      return [];
    }

    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    
    if (!worksheet) {
      console.error(`Não foi possível acessar a planilha: ${firstSheetName}`);
      return [];
    }

    // Converte para matriz de strings (mais leve que objetos para 100MB+)
    const rows = XLSX.utils.sheet_to_json(worksheet, { 
      header: 1, 
      defval: '',
      blankrows: false 
    }) as any[][];

    if (rows.length === 0) return [];

    // Identifica se a primeira linha é cabeçalho
    const firstRowStr = JSON.stringify(rows[0]).toLowerCase();
    const hasHeader = firstRowStr.includes('codigo') || firstRowStr.includes('código') || firstRowStr.includes('tipo');
    const startIndex = hasHeader ? 1 : 0;

    const result: any[] = [];
    
    for (let i = startIndex; i < rows.length; i++) {
      const cols = rows[i];
      
      // Validação básica: a linha deve ter pelo menos o código e a descrição
      // Para CATSER (8 colunas esperadas) e CATMAT (10 colunas esperadas)
      if (!cols || cols.length < 5) continue;

      if (isMaterial) {
        // Mapeamento CATMAT (Baseado na estrutura padrão do SIASG)
        // 0:GrupoCod, 1:GrupoDesc, 2:ClasseCod, 3:ClasseDesc, 4:PDMCod, 5:PDMDesc, 6:ItemCod, 7:ItemDesc, 8:NCM, 9:Status
        const item: MaterialItem = {
          tipo: 'Material',
          grupoCodigo: cleanText(cols[0]),
          grupoDescricao: cleanText(cols[1]),
          classeCodigo: cleanText(cols[2]),
          classeDescricao: cleanText(cols[3]),
          pdmCodigo: cleanText(cols[4]),
          pdmDescricao: cleanText(cols[5]),
          codigoMaterial: cleanText(cols[6]),
          descricaoMaterial: cleanText(cols[7]),
          ncmCodigo: cleanText(cols[8]),
          situacao: cleanText(cols[9]) || 'Ativo'
        };
        if (item.codigoMaterial) result.push(item);
      } else {
        // Mapeamento CATSER
        // 0:Tipo, 1:GrupoCod, 2:GrupoDesc, 3:ClasseCod, 4:ClasseDesc, 5:ServicoCod, 6:ServicoDesc, 7:Status
        const item: ServiceItem = {
          tipo: cleanText(cols[0]) || 'Serviço',
          grupoCodigo: cleanText(cols[1]),
          grupoDescricao: cleanText(cols[2]),
          classeCodigo: cleanText(cols[3]),
          classeDescricao: cleanText(cols[4]),
          codigoServico: cleanText(cols[5]),
          descricaoServico: cleanText(cols[6]),
          situacao: cleanText(cols[7]) || 'Ativo'
        };
        if (item.codigoServico) result.push(item);
      }
    }

    console.log(`Parse concluído: ${result.length} itens processados.`);
    return result;
  } catch (error) {
    console.error("Erro crítico no parser:", error);
    return [];
  }
};
